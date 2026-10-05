//! Passive retained custody reads: SQLite only opens a verified private copy.
//! Source files are never opened through SQLite, checkpointed, or recovered.
use super::*;
use std::os::unix::fs::DirBuilderExt;

type Stamp = (u64, u64, u64, i64, i64, i64, i64);

fn metadata_stamp(m: &fs::Metadata) -> Stamp {
    (
        m.dev(),
        m.ino(),
        m.len(),
        m.mtime(),
        m.mtime_nsec(),
        m.ctime(),
        m.ctime_nsec(),
    )
}
fn open_pinned(path: &Path, expected: Stamp) -> Result<File> {
    private(path, false)?;
    let file: File = rustix::fs::open(
        path,
        rustix::fs::OFlags::RDONLY | rustix::fs::OFlags::NOFOLLOW | rustix::fs::OFlags::CLOEXEC,
        rustix::fs::Mode::empty(),
    )?
    .into();
    if metadata_stamp(&file.metadata()?) != expected || stamp(path)? != expected {
        return Err(error("retained-sqlite-family-changed"));
    }
    Ok(file)
}
fn stream(path: &Path, expected: Stamp, target: Option<&Path>) -> Result<String> {
    let mut source = open_pinned(path, expected)?;
    let mut output = target
        .map(|path| {
            OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(path)
        })
        .transpose()?;
    let mut hash = Sha256::new();
    let mut count = 0u64;
    let mut block = [0u8; 65536];
    loop {
        // One extra byte detects growth without an unbounded read from a moving writer.
        let capacity =
            (expected.2.saturating_sub(count).saturating_add(1)).min(block.len() as u64) as usize;
        let read = source.read(&mut block[..capacity])?;
        if read == 0 {
            break;
        }
        count = count
            .checked_add(read as u64)
            .ok_or_else(|| error("retained-sqlite-family-invalid"))?;
        if count > expected.2 {
            return Err(error("retained-sqlite-family-changed"));
        }
        hash.update(&block[..read]);
        if let Some(file) = &mut output {
            file.write_all(&block[..read])?;
        }
    }
    if count != expected.2
        || metadata_stamp(&source.metadata()?) != expected
        || stamp(path)? != expected
    {
        return Err(error("retained-sqlite-family-changed"));
    }
    Ok(hex::encode(hash.finalize()))
}

fn stamp(path: &Path) -> Result<Stamp> {
    private(path, false)?;
    Ok(metadata_stamp(&fs::symlink_metadata(path)?))
}
fn be(bytes: &[u8]) -> u32 {
    u32::from_be_bytes(bytes.try_into().expect("four-byte WAL field"))
}
fn checksum(bytes: &[u8], big: bool, mut sum: (u32, u32)) -> (u32, u32) {
    for words in bytes.chunks_exact(8) {
        let word = |b: &[u8]| {
            if big {
                be(b)
            } else {
                u32::from_le_bytes(b.try_into().unwrap())
            }
        };
        sum.0 = sum.0.wrapping_add(word(&words[..4])).wrapping_add(sum.1);
        sum.1 = sum.1.wrapping_add(word(&words[4..])).wrapping_add(sum.0);
    }
    sum
}
fn validate_wal(main_path: &Path, wal_path: &Path) -> Result<u64> {
    let mut main_file = File::open(main_path)?;
    let mut wal_file = File::open(wal_path)?;
    let wal_length = wal_file.metadata()?.len();
    if wal_length == 0 {
        return Ok(0);
    }
    let mut main = [0u8; 100];
    let mut wal = [0u8; 32];
    main_file.read_exact(&mut main)?;
    wal_file.read_exact(&mut wal)?;
    if &main[..16] != b"SQLite format 3\0"
        || main[18..20] != [2, 2]
        || wal_length < 32
        || !matches!(be(&wal[..4]), 0x377f0682 | 0x377f0683)
        || be(&wal[4..8]) != 3007000
    {
        return Err(error("retained-sqlite-family-invalid"));
    }
    let page = be(&wal[8..12]) as usize;
    let main_page = u16::from_be_bytes([main[16], main[17]]) as usize;
    let main_page = if main_page == 1 { 65536 } else { main_page };
    if page != main_page
        || !(512..=65536).contains(&page)
        || !page.is_power_of_two()
        || (wal_length - 32) % (page as u64 + 24) != 0
    {
        return Err(error("retained-sqlite-family-invalid"));
    }
    let big = be(&wal[..4]) == 0x377f0683;
    let mut sum = checksum(&wal[..24], big, (0, 0));
    if sum != (be(&wal[24..28]), be(&wal[28..32])) {
        return Err(error("retained-sqlite-family-invalid"));
    }
    let mut frame = vec![0u8; page + 24];
    let mut max_database = 0u64;
    for _ in 0..(wal_length - 32) / (page as u64 + 24) {
        wal_file.read_exact(&mut frame)?;
        max_database = max_database.max(u64::from(be(&frame[4..8])) * page as u64);
        if be(&frame[..4]) == 0 || frame[8..16] != wal[16..24] {
            return Err(error("retained-sqlite-family-invalid"));
        }
        sum = checksum(&frame[24..], big, checksum(&frame[..8], big, sum));
        if sum != (be(&frame[16..20]), be(&frame[20..24])) {
            return Err(error("retained-sqlite-family-invalid"));
        }
    }
    Ok(max_database)
}

pub(super) fn inspect(path: &Path, sql: &str, key: &str) -> Result<Vec<String>> {
    if !present(path)? {
        return Ok(Vec::new());
    }
    let parent = path
        .parent()
        .ok_or_else(|| error("recovery-parent-missing"))?;
    private(parent, true)?;
    let parent_identity = fs::metadata(parent)?;
    let wal_path = PathBuf::from(format!("{}-wal", path.display()));
    let journal_path = PathBuf::from(format!("{}-journal", path.display()));
    // No live recovery or super-journal adoption; rollback families remain an explicit refusal.
    if present(&journal_path)? {
        return Err(error("retained-sqlite-rollback-family-refused"));
    }
    let main_stamp = stamp(path)?;
    let wal_stamp = if present(&wal_path)? {
        Some(stamp(&wal_path)?)
    } else {
        None
    };
    let mut nonce = [0u8; 24];
    File::open("/dev/urandom")?.read_exact(&mut nonce)?;
    let directory = parent.join(format!(
        ".openclaw-retained-inspection-{}",
        hex::encode(nonce)
    ));
    fs::DirBuilder::new().mode(0o700).create(&directory)?;
    let created = fs::symlink_metadata(&directory)?;
    let result = (|| -> Result<Vec<String>> {
        private(&directory, true)?;
        let copy = directory.join("database.sqlite");
        let family_bytes = main_stamp
            .2
            .checked_add(wal_stamp.map(|s| s.2).unwrap_or(0))
            .ok_or_else(|| error("retained-sqlite-capacity-insufficient"))?;
        let volume = rustix::fs::statvfs(&directory)?;
        let available = volume.f_bavail.saturating_mul(volume.f_frsize);
        // Reserve copy space plus another main/WAL family for private SQLite activity.
        if family_bytes
            .checked_mul(2)
            .and_then(|n| n.checked_add(65536))
            .is_none_or(|required| required > available)
        {
            return Err(error("retained-sqlite-capacity-insufficient"));
        }
        let main_digest = stream(path, main_stamp, Some(&copy))?;
        let copied_wal = directory.join("database.sqlite-wal");
        let wal_digest = wal_stamp
            .map(|expected| stream(&wal_path, expected, Some(&copied_wal)))
            .transpose()?;
        if wal_stamp.is_some() {
            let expansion = validate_wal(&copy, &copied_wal)?;
            let current = rustix::fs::statvfs(&directory)?;
            if expansion
                .checked_add(65536)
                .is_none_or(|required| required > current.f_bavail.saturating_mul(current.f_frsize))
            {
                return Err(error("retained-sqlite-capacity-insufficient"));
            }
        }
        let assert_source = || -> Result<()> {
            private(parent, true)?;
            let current_parent = fs::metadata(parent)?;
            if (current_parent.dev(), current_parent.ino())
                != (parent_identity.dev(), parent_identity.ino())
                || stream(path, main_stamp, None)? != main_digest
                || present(&journal_path)?
                || present(&wal_path)? != wal_stamp.is_some()
            {
                return Err(error("retained-sqlite-family-changed"));
            }
            if let Some(expected) = wal_stamp {
                if Some(stream(&wal_path, expected, None)?) != wal_digest {
                    return Err(error("retained-sqlite-family-changed"));
                }
            }
            Ok(())
        };
        assert_source()?;
        // RW only on the private copy: SQLite can build private SHM and read committed WAL.
        // immutable=1 is deliberately forbidden here because it ignores committed WAL.
        let connection = Connection::open_with_flags(
            &copy,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        connection.pragma_update(None, "trusted_schema", false)?;
        connection.pragma_update(None, "query_only", true)?;
        let rows = connection
            .prepare(sql)?
            .query_map([key], |row| row.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        drop(connection);
        assert_source()?;
        Ok(rows)
    })();
    let cleanup = (|| -> Result<()> {
        private(&directory, true)?;
        let current = fs::symlink_metadata(&directory)?;
        if (current.dev(), current.ino()) != (created.dev(), created.ino()) {
            return Err(error("retained-inspection-directory-changed"));
        }
        fs::remove_dir_all(&directory)?;
        Ok(())
    })();
    match (result, cleanup) {
        (Ok(rows), Ok(())) => Ok(rows),
        (Err(cause), Ok(())) => Err(cause),
        (Ok(_), Err(cleanup)) => Err(cleanup.into()),
        (Err(cause), Err(cleanup)) => Err(error(&format!(
            "{cause}; retained inspection cleanup: {cleanup}"
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (tempfile::TempDir, PathBuf, Vec<u8>, Vec<u8>) {
        let root = tempfile::tempdir().unwrap();
        fs::set_permissions(root.path(), fs::Permissions::from_mode(0o700)).unwrap();
        let seed = root.path().join("seed.sqlite");
        let writer = Connection::open(&seed).unwrap();
        writer.execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE update_runs(run_id TEXT PRIMARY KEY, created_at_ms INTEGER, status TEXT); CREATE TABLE config_machine_state(state_key TEXT PRIMARY KEY,value_json TEXT); PRAGMA wal_checkpoint(TRUNCATE);").unwrap();
        writer.execute_batch("BEGIN; INSERT INTO update_runs VALUES('original',123,'running'); INSERT INTO config_machine_state VALUES('update.recipe-run.original','{\"runId\":\"original\",\"createdAtMs\":123}'); COMMIT;").unwrap();
        // Freeze the actual committed WAL family while the writer is open. Closing seed
        // may checkpoint seed, but the separately frozen crash family cannot change.
        let main = fs::read(&seed).unwrap();
        let wal = fs::read(root.path().join("seed.sqlite-wal")).unwrap();
        drop(writer);
        let source = root.path().join("original.sqlite");
        fs::write(&source, &main).unwrap();
        fs::write(root.path().join("original.sqlite-wal"), &wal).unwrap();
        for file in [&source, &root.path().join("original.sqlite-wal")] {
            fs::set_permissions(file, fs::Permissions::from_mode(0o600)).unwrap();
        }
        (root, source, main, wal)
    }

    #[test]
    fn reads_original_pointer_committed_only_in_wal_without_source_recovery() {
        let (root, source, main, wal) = fixture();
        // The legacy immutable owner misses the row; this proves WAL is necessary.
        let mut uri = Url::from_file_path(&source).unwrap();
        uri.set_query(Some("mode=ro&immutable=1"));
        let base = Connection::open_with_flags(
            uri.as_str(),
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI,
        )
        .unwrap();
        assert_eq!(
            base.query_row("SELECT count(*) FROM update_runs", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        drop(base);
        let rows = inspect(&source, "SELECT json_object('runId',r.run_id,'createdAtMs',r.created_at_ms,'status',r.status,'pointer',json(p.value_json)) FROM update_runs r JOIN config_machine_state p ON p.state_key='update.recipe-run.'||r.run_id WHERE r.run_id=?1", "original").unwrap();
        assert_eq!(rows.len(), 1);
        let row: serde_json::Value = serde_json::from_str(&rows[0]).unwrap();
        assert_eq!(row["pointer"]["runId"], "original");
        assert_eq!(row["createdAtMs"], 123);
        assert_eq!(fs::read(&source).unwrap(), main);
        assert_eq!(
            fs::read(root.path().join("original.sqlite-wal")).unwrap(),
            wal
        );
        assert!(!root.path().join("original.sqlite-shm").exists());
        assert!(!fs::read_dir(root.path()).unwrap().any(|p| p
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".openclaw-retained-inspection-")));
    }

    #[test]
    fn reads_wal_pointer_with_large_sparse_original_without_size_class_assumption() {
        let (root, source, _, wal) = fixture();
        // SQLite permits trailing pages beyond its logical header size. Preserve a
        // real main/WAL family while making the physical original larger than the
        // old unrelated trust-artifact 64MiB limit, without allocating it in RAM.
        OpenOptions::new()
            .write(true)
            .open(&source)
            .unwrap()
            .set_len(65 * 1024 * 1024)
            .unwrap();
        let before = stamp(&source).unwrap();
        let original_hash = stream(&source, before, None).unwrap();
        let rows = inspect(&source, "SELECT p.value_json FROM update_runs r JOIN config_machine_state p ON p.state_key='update.recipe-run.'||r.run_id WHERE r.run_id=?1 AND r.status='running'", "original").unwrap();
        assert_eq!(rows.len(), 1);
        let pointer: serde_json::Value = serde_json::from_str(&rows[0]).unwrap();
        assert_eq!(pointer["runId"], "original");
        assert_eq!(stamp(&source).unwrap(), before);
        assert_eq!(stream(&source, before, None).unwrap(), original_hash);
        assert_eq!(
            fs::read(root.path().join("original.sqlite-wal")).unwrap(),
            wal
        );
        assert!(!root.path().join("original.sqlite-shm").exists());
    }

    #[test]
    fn streaming_reader_refuses_replaced_original_identity() {
        let (root, source, _, _) = fixture();
        let original = stamp(&source).unwrap();
        let replacement = root.path().join("replacement.sqlite");
        fs::copy(&source, &replacement).unwrap();
        fs::rename(replacement, &source).unwrap();
        assert!(stream(&source, original, None).is_err());
    }

    #[test]
    fn refuses_torn_or_corrupt_wal_without_ignoring_original_commits() {
        let (root, source, main, mut wal) = fixture();
        let path = root.path().join("original.sqlite-wal");
        wal.pop();
        fs::write(&path, &wal).unwrap();
        assert!(inspect(
            &source,
            "SELECT status FROM update_runs WHERE run_id=?1",
            "original"
        )
        .is_err());
        assert_eq!(fs::read(&source).unwrap(), main);
        assert_eq!(fs::read(&path).unwrap(), wal);
        wal.push(0);
        wal[32 + 24] ^= 1;
        fs::write(&path, &wal).unwrap();
        assert!(inspect(
            &source,
            "SELECT status FROM update_runs WHERE run_id=?1",
            "original"
        )
        .is_err());
        assert!(!root.path().join("original.sqlite-shm").exists());
    }

    #[test]
    fn refuses_rollback_family_without_touching_it() {
        let (root, source, main, _) = fixture();
        let journal = root.path().join("original.sqlite-journal");
        fs::write(&journal, b"rollback-custody").unwrap();
        assert!(inspect(
            &source,
            "SELECT status FROM update_runs WHERE run_id=?1",
            "original"
        )
        .is_err());
        assert_eq!(fs::read(&journal).unwrap(), b"rollback-custody");
        assert_eq!(fs::read(&source).unwrap(), main);
    }
}
