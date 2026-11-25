use super::{runtime_directory, validate_manifest, Manifest, RuntimeResult};
use std::collections::BTreeSet;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};

/// Called only after activation and Gateway health succeed; failures leave seeds in place.
pub(crate) fn collect_after_healthy(prefix: &Path, references: &[PathBuf]) -> Result<(), String> {
    collect(prefix, references, &live_executables).map_err(|error| error.to_string())
}

pub(super) fn collect(
    prefix: &Path,
    references: &[PathBuf],
    processes: &dyn Fn(&BTreeSet<OsString>) -> RuntimeResult<Vec<PathBuf>>,
) -> RuntimeResult<()> {
    let store = prefix.join("tools/desktop-runtime");
    if !fs::symlink_metadata(&store)?.is_dir() {
        return Err("Runtime store is redirected.".into());
    }
    super::ensure_directory(&store)?;
    let mut candidates = Vec::new();
    let mut names = BTreeSet::new();
    for entry in fs::read_dir(&store)? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let directory = entry.path();
        let Ok(bytes) = fs::read_to_string(directory.join("manifest.json")) else {
            continue;
        };
        let Ok(manifest) = serde_json::from_str::<Manifest>(&bytes) else {
            continue;
        };
        if validate_manifest(&manifest).is_err()
            || runtime_directory(prefix, &bytes, &manifest) != directory
        {
            continue;
        }
        names.extend(
            manifest
                .files
                .keys()
                .filter_map(|file| Path::new(file).file_name().map(OsString::from)),
        );
        candidates.push(fs::canonicalize(directory)?);
    }
    // Resolve every reference and finish the process census before deleting anything.
    let mut retained = references
        .iter()
        .map(fs::canonicalize)
        .collect::<Result<Vec<_>, _>>()?;
    retained.extend(processes(&names)?);
    for directory in candidates {
        if !retained.iter().any(|path| path.starts_with(&directory)) {
            fs::remove_dir_all(directory)?;
        }
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn live_executables(_: &BTreeSet<OsString>) -> RuntimeResult<Vec<PathBuf>> {
    use std::os::unix::fs::MetadataExt;
    let mut paths = Vec::new();
    for entry in fs::read_dir("/proc")? {
        let entry = entry?;
        if entry.file_name().to_string_lossy().parse::<u32>().is_err() {
            continue;
        }
        let directory = entry.path();
        let metadata = match fs::metadata(&directory) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error.into()),
        };
        if metadata.uid() != unsafe { libc::geteuid() } {
            continue;
        }
        if let Some(path) = executable_path(&directory)? {
            paths.push(path);
        }
    }
    Ok(paths)
}

#[cfg(target_os = "linux")]
pub(super) fn executable_path(directory: &Path) -> RuntimeResult<Option<PathBuf>> {
    match fs::read_link(directory.join("exe")) {
        Ok(path) => Ok(Some(path)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            // Exited processes and zombies have no executable; unreadable live ones defer GC.
            let stat = match fs::read_to_string(directory.join("stat")) {
                Ok(stat) => stat,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
                Err(error) => return Err(error.into()),
            };
            if stat
                .rsplit_once(") ")
                .is_some_and(|(_, tail)| tail.starts_with('Z'))
            {
                Ok(None)
            } else {
                Err(error.into())
            }
        }
        Err(error) => Err(error.into()),
    }
}

#[cfg(target_os = "windows")]
fn live_executables(names: &BTreeSet<OsString>) -> RuntimeResult<Vec<PathBuf>> {
    use std::os::windows::ffi::OsStringExt;
    use windows::Win32::Foundation::{CloseHandle, ERROR_NO_MORE_FILES};
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) }?;
    let result = (|| -> RuntimeResult<Vec<PathBuf>> {
        let mut paths = Vec::new();
        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        let mut next = unsafe { Process32FirstW(snapshot, &mut entry) };
        while next.is_ok() {
            let end = entry
                .szExeFile
                .iter()
                .position(|value| *value == 0)
                .unwrap_or(entry.szExeFile.len());
            let name = OsString::from_wide(&entry.szExeFile[..end]);
            // Only seed executable names can reference a seed. Avoid protected system processes.
            if names.iter().any(|candidate| {
                candidate
                    .to_string_lossy()
                    .eq_ignore_ascii_case(&name.to_string_lossy())
            }) {
                let process = unsafe {
                    OpenProcess(
                        PROCESS_QUERY_LIMITED_INFORMATION,
                        false,
                        entry.th32ProcessID,
                    )
                }?;
                let mut buffer = vec![0u16; 32768];
                let mut length = buffer.len() as u32;
                let query = unsafe {
                    QueryFullProcessImageNameW(
                        process,
                        PROCESS_NAME_WIN32,
                        windows::core::PWSTR(buffer.as_mut_ptr()),
                        &mut length,
                    )
                };
                let _ = unsafe { CloseHandle(process) };
                query?;
                paths.push(fs::canonicalize(PathBuf::from(OsString::from_wide(
                    &buffer[..length as usize],
                )))?);
            }
            next = unsafe { Process32NextW(snapshot, &mut entry) };
        }
        if let Err(error) = next {
            if error.code() != ERROR_NO_MORE_FILES.to_hresult() {
                return Err(error.into());
            }
        }
        Ok(paths)
    })();
    let _ = unsafe { CloseHandle(snapshot) };
    result
}

#[cfg(target_os = "macos")]
fn live_executables(_: &BTreeSet<OsString>) -> RuntimeResult<Vec<PathBuf>> {
    use std::os::unix::ffi::OsStringExt;
    // Match Linux's per-user census; an incomplete census defers all collection.
    const PROC_UID_ONLY: u32 = 4; // sys/proc_info.h; libc exposes proc_listpids but not this selector.
    let uid = unsafe { libc::geteuid() };
    let required = unsafe { libc::proc_listpids(PROC_UID_ONLY, uid, std::ptr::null_mut(), 0) };
    if required <= 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    let mut pids = vec![0_i32; required as usize / std::mem::size_of::<i32>() + 64];
    let capacity = pids.len() * std::mem::size_of::<i32>();
    let actual = unsafe {
        libc::proc_listpids(
            PROC_UID_ONLY,
            uid,
            pids.as_mut_ptr().cast(),
            capacity as i32,
        )
    };
    if actual <= 0 || actual as usize >= capacity {
        return Err("Could not complete the runtime process census.".into());
    }
    pids.truncate(actual as usize / std::mem::size_of::<i32>());
    let mut paths = Vec::new();
    for pid in pids.into_iter().filter(|pid| *pid > 0) {
        let mut bytes = vec![0_u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
        let count =
            unsafe { libc::proc_pidpath(pid, bytes.as_mut_ptr().cast(), bytes.len() as u32) };
        if count <= 0 {
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() == Some(libc::ESRCH) {
                continue;
            }
            return Err(error.into());
        }
        bytes.truncate(
            bytes
                .iter()
                .position(|byte| *byte == 0)
                .unwrap_or(count as usize),
        );
        paths.push(PathBuf::from(OsString::from_vec(bytes)));
    }
    Ok(paths)
}

#[cfg(not(any(target_os = "linux", target_os = "windows", target_os = "macos")))]
fn live_executables(_: &BTreeSet<OsString>) -> RuntimeResult<Vec<PathBuf>> {
    Err("Runtime seed collection is unsupported on this platform.".into())
}
