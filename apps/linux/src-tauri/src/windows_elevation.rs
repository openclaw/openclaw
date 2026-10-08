//! A one-shot transport to the canonical CLI; the service owner retains all authority.
use serde_json::{json, Value};
use std::ffi::{OsStr, OsString};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, Write};
use std::os::windows::ffi::{OsStrExt, OsStringExt};
use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::process::Command;
use windows::core::PCWSTR;
use windows::Win32::Foundation::{
    CloseHandle, ERROR_CANCELLED, HANDLE, RPC_E_CHANGED_MODE, WAIT_OBJECT_0,
};
use windows::Win32::Security::{
    GetTokenInformation, TokenElevation, TokenElevationType, TokenElevationTypeLimited,
    TOKEN_ELEVATION, TOKEN_ELEVATION_TYPE, TOKEN_QUERY,
};
use windows::Win32::System::Com::{
    CoInitializeEx, CoTaskMemFree, CoUninitialize, COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE,
};
use windows::Win32::System::Threading::{
    GetCurrentProcess, GetExitCodeProcess, OpenProcessToken, WaitForSingleObject, INFINITE,
};
use windows::Win32::UI::Shell::{
    FOLDERID_Profile, SHGetKnownFolderPath, ShellExecuteExW, KF_FLAG_DEFAULT, SEE_MASK_FLAG_NO_UI,
    SEE_MASK_NOASYNC, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW,
};
use windows::Win32::UI::WindowsAndMessaging::SW_HIDE;

const RECEIPT_LIMIT: u64 = 1024 * 1024;
const OPEN_REPARSE_POINT: u32 = 0x00200000;
const BACKUP_SEMANTICS: u32 = 0x02000000;
const REPARSE_POINT: u32 = 0x400;

#[derive(Debug, Eq, PartialEq)]
pub(crate) enum ElevationError {
    Cancelled,
    NonAdministrator,
    Failed(String),
}

struct Handle(HANDLE);
impl Drop for Handle {
    fn drop(&mut self) {
        let _ = unsafe { CloseHandle(self.0) };
    }
}

pub(crate) fn is_elevated() -> Result<bool, String> {
    read_elevation().map(|(_, elevated)| elevated)
}

/// Reject credential elevation into a different account before displaying UAC.
pub(crate) fn can_elevate() -> Result<bool, String> {
    let (kind, elevated) = read_elevation()?;
    Ok(kind == TokenElevationTypeLimited || elevated)
}

fn read_elevation() -> Result<(TOKEN_ELEVATION_TYPE, bool), String> {
    let mut raw = HANDLE::default();
    unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut raw) }
        .map_err(|error| error.to_string())?;
    let token = Handle(raw);
    let mut kind = TOKEN_ELEVATION_TYPE::default();
    let mut elevated = TOKEN_ELEVATION::default();
    let mut length = 0;
    unsafe {
        GetTokenInformation(
            token.0,
            TokenElevationType,
            Some((&mut kind as *mut TOKEN_ELEVATION_TYPE).cast()),
            size_of::<TOKEN_ELEVATION_TYPE>() as u32,
            &mut length,
        )
        .map_err(|error| error.to_string())?;
        GetTokenInformation(
            token.0,
            TokenElevation,
            Some((&mut elevated as *mut TOKEN_ELEVATION).cast()),
            size_of::<TOKEN_ELEVATION>() as u32,
            &mut length,
        )
    }
    .map_err(|error: windows::core::Error| error.to_string())?;
    Ok((kind, elevated.TokenIsElevated != 0))
}

struct Invocation {
    program: Vec<u16>,
    arguments: Vec<u16>,
    directory: Option<Vec<u16>>,
}

impl Invocation {
    fn new(command: &Command) -> Result<Self, String> {
        let path = Path::new(command.get_program());
        if !path.is_absolute()
            || !path
                .extension()
                .is_some_and(|ext| ext.eq_ignore_ascii_case("exe"))
        {
            return Err("Elevation requires an absolute CLI executable path.".into());
        }
        if command.get_envs().next().is_some() {
            return Err("Elevation cannot carry command-specific environment changes.".into());
        }
        let mut arguments = Vec::new();
        for argument in command.get_args() {
            if !arguments.is_empty() {
                arguments.push(b' ' as u16);
            }
            arguments.extend(quote_argument(argument)?);
        }
        arguments.push(0);
        Ok(Self {
            program: wide(command.get_program())?,
            arguments,
            directory: command
                .get_current_dir()
                .map(|path| wide(path.as_os_str()))
                .transpose()?,
        })
    }
}

fn wide(value: &OsStr) -> Result<Vec<u16>, String> {
    let mut value: Vec<u16> = value.encode_wide().collect();
    if value.contains(&0) {
        return Err("A CLI argument contains a NUL character.".into());
    }
    value.push(0);
    Ok(value)
}

/// Encode the Microsoft CRT argument contract used by Node, without a shell.
fn quote_argument(value: &OsStr) -> Result<Vec<u16>, String> {
    let units = wide(value)?;
    let mut result = vec![b'"' as u16];
    let mut slashes = 0;
    for &unit in &units[..units.len() - 1] {
        if unit == b'\\' as u16 {
            slashes += 1;
            continue;
        }
        result.extend(std::iter::repeat_n(
            b'\\' as u16,
            slashes * if unit == b'"' as u16 { 2 } else { 1 },
        ));
        if unit == b'"' as u16 {
            result.push(b'\\' as u16);
        }
        result.push(unit);
        slashes = 0;
    }
    result.extend(std::iter::repeat_n(b'\\' as u16, slashes * 2));
    result.push(b'"' as u16);
    Ok(result)
}

pub(crate) fn run(command: &Command) -> Result<u32, ElevationError> {
    run_with(command, can_elevate, |invocation| {
        struct Apartment(bool);
        impl Drop for Apartment {
            fn drop(&mut self) {
                if self.0 {
                    unsafe { CoUninitialize() };
                }
            }
        }
        let initialized =
            unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) };
        if initialized.is_err() && initialized != RPC_E_CHANGED_MODE {
            return Err(ElevationError::Failed(initialized.to_string()));
        }
        let _apartment = Apartment(initialized.is_ok());
        let verb = wide(OsStr::new("runas")).map_err(ElevationError::Failed)?;
        let mut info = SHELLEXECUTEINFOW {
            cbSize: size_of::<SHELLEXECUTEINFOW>() as u32,
            fMask: SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC | SEE_MASK_FLAG_NO_UI,
            lpVerb: PCWSTR(verb.as_ptr()),
            lpFile: PCWSTR(invocation.program.as_ptr()),
            lpParameters: PCWSTR(invocation.arguments.as_ptr()),
            lpDirectory: invocation
                .directory
                .as_ref()
                .map_or(PCWSTR::null(), |path| PCWSTR(path.as_ptr())),
            nShow: SW_HIDE.0,
            ..Default::default()
        };
        unsafe { ShellExecuteExW(&mut info) }.map_err(shell_error)?;
        let process = Handle(info.hProcess);
        if process.0.is_invalid() {
            return Err(ElevationError::Failed(
                "Windows returned no elevated CLI process.".into(),
            ));
        }
        // No timeout or kill: interrupting the CLI could split its owner-held transaction.
        if unsafe { WaitForSingleObject(process.0, INFINITE) } != WAIT_OBJECT_0 {
            return Err(ElevationError::Failed(
                "Could not wait for the elevated CLI.".into(),
            ));
        }
        let mut code = 0;
        unsafe { GetExitCodeProcess(process.0, &mut code) }
            .map_err(|error| ElevationError::Failed(error.to_string()))?;
        Ok(code)
    })
}

fn shell_error(error: windows::core::Error) -> ElevationError {
    if error.code() == windows::core::HRESULT::from_win32(ERROR_CANCELLED.0) {
        ElevationError::Cancelled
    } else {
        ElevationError::Failed(error.to_string())
    }
}

fn run_with(
    command: &Command,
    eligible: impl FnOnce() -> Result<bool, String>,
    dispatch: impl FnOnce(&Invocation) -> Result<u32, ElevationError>,
) -> Result<u32, ElevationError> {
    let invocation = Invocation::new(command).map_err(ElevationError::Failed)?;
    if !eligible().map_err(ElevationError::Failed)? {
        return Err(ElevationError::NonAdministrator);
    }
    dispatch(&invocation)
}

/// Start-Process accepts one already-encoded string; PS5 otherwise strips JSON quotes.
pub(crate) fn format_manual_command(command: &Command, elevated: bool) -> Result<String, String> {
    let invocation = Invocation::new(command)?;
    let quote = |units: &[u16]| -> Result<String, String> {
        String::from_utf16(&units[..units.len() - 1])
            .map(|value| format!("'{}'", value.replace('\'', "''")))
            .map_err(|_| "The CLI command contains invalid Unicode.".into())
    };
    let directory = invocation
        .directory
        .as_ref()
        .map(|value| quote(value).map(|value| format!(" -WorkingDirectory {value}")))
        .transpose()?
        .unwrap_or_default();
    let verb = if elevated { " -Verb RunAs" } else { "" };
    Ok(format!(
        "(Start-Process -FilePath {} -ArgumentList {}{directory}{verb} -Wait -PassThru).ExitCode",
        quote(&invocation.program)?,
        quote(&invocation.arguments)?
    ))
}

pub(crate) struct Request {
    path: PathBuf,
    pending: Value,
    file: Option<File>,
    directories: Vec<File>,
}

impl Request {
    pub(crate) fn create(runtime_path: &Path, expected_pin: &Value) -> Result<Self, String> {
        let raw = unsafe { SHGetKnownFolderPath(&FOLDERID_Profile, KF_FLAG_DEFAULT, None) }
            .map_err(|error| error.to_string())?;
        let profile = PathBuf::from(OsString::from_wide(unsafe { raw.as_wide() }));
        unsafe { CoTaskMemFree(Some(raw.0.cast())) };
        Self::create_at(&profile, runtime_path, expected_pin)
    }

    fn create_at(
        profile: &Path,
        runtime_path: &Path,
        expected_pin: &Value,
    ) -> Result<Self, String> {
        let parent = profile.join(".openclaw").join("desktop-runtime-actions");
        let mut directories = Vec::new();
        for ancestor in parent.ancestors().collect::<Vec<_>>().into_iter().rev() {
            match fs::symlink_metadata(ancestor) {
                Ok(_) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    match fs::create_dir(ancestor) {
                        Ok(()) => {}
                        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                        Err(error) => return Err(error.to_string()),
                    }
                }
                Err(error) => return Err(error.to_string()),
            }
            directories.push(open_directory(ancestor)?);
        }
        let nonce = uuid::Uuid::new_v4().to_string();
        let directory = parent.join(&nonce);
        fs::create_dir(&directory).map_err(|error| error.to_string())?;
        let mut request = Self {
            path: directory.join("result.json"),
            file: None,
            directories,
            pending: json!({"version": 1, "kind": "openclaw-desktop-runtime", "phase": "pending",
                "nonce": nonce, "request": {"runtime": "bun", "runtimePath": runtime_path,
                    "expectedRuntimePin": expected_pin}}),
        };
        request.directories.push(open_directory(&directory)?);
        let mut file = OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .share_mode(3)
            .custom_flags(OPEN_REPARSE_POINT)
            .open(&request.path)
            .map_err(|error| error.to_string())?;
        file.write_all(request.pending.to_string().as_bytes())
            .and_then(|_| file.sync_all())
            .map_err(|error| error.to_string())?;
        request.file = Some(file);
        Ok(request)
    }

    pub(crate) fn argument_json(&self) -> String {
        json!({"path": self.path, "nonce": self.pending["nonce"]}).to_string()
    }

    pub(crate) fn read_completed(&mut self) -> Result<Value, String> {
        let file = self.file.as_mut().ok_or("The runtime receipt is closed.")?;
        file.rewind().map_err(|error| error.to_string())?;
        let mut bytes = Vec::new();
        file.take(RECEIPT_LIMIT + 1)
            .read_to_end(&mut bytes)
            .map_err(|error| error.to_string())?;
        if bytes.len() as u64 > RECEIPT_LIMIT {
            return Err("The runtime receipt exceeded its limit.".into());
        }
        let result: Value = serde_json::from_slice(&bytes)
            .map_err(|_| "The CLI returned no valid runtime receipt.")?;
        if result["phase"] != "complete"
            || ["version", "kind", "nonce", "request"]
                .iter()
                .any(|key| result[key] != self.pending[key])
            || !result["install"].is_object()
        {
            return Err("The CLI returned no matching completed runtime receipt.".into());
        }
        Ok(result)
    }
}

fn open_directory(path: &Path) -> Result<File, String> {
    let directory = OpenOptions::new()
        .read(true)
        .share_mode(3)
        .custom_flags(OPEN_REPARSE_POINT | BACKUP_SEMANTICS)
        .open(path)
        .map_err(|error| error.to_string())?;
    let metadata = directory.metadata().map_err(|error| error.to_string())?;
    if !metadata.is_dir() || metadata.file_attributes() & REPARSE_POINT != 0 {
        return Err("The runtime receipt directory is redirected.".into());
    }
    Ok(directory)
}

impl Drop for Request {
    fn drop(&mut self) {
        drop(self.file.take());
        self.directories.clear();
        let _ = fs::remove_file(&self.path);
        if let Some(directory) = self.path.parent() {
            let _ = fs::remove_dir(directory);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    use windows::Win32::Foundation::LocalFree;
    use windows::Win32::UI::Shell::CommandLineToArgvW;

    struct Fixture(PathBuf);

    impl Fixture {
        fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("openclaw-receipt-{}", uuid::Uuid::new_v4()));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn windows_argument_transport_preserves_json_spaces_quotes_and_trailing_slashes() {
        let arguments = [
            "",
            r"C:\Program Files\雪\",
            r#"{"revision":"a","definition":"b"}"#,
            "a\"b",
            r"a\\\",
            "'$(ignored);&",
        ];
        let mut command = Command::new(r"C:\Program Files\Node\node.exe");
        command.args(arguments);
        let invocation = Invocation::new(&command).unwrap();
        let mut full = quote_argument(command.get_program()).unwrap();
        full.push(b' ' as u16);
        full.extend(&invocation.arguments);
        let mut count = 0;
        let raw = unsafe { CommandLineToArgvW(PCWSTR(full.as_ptr()), &mut count) };
        assert!(!raw.is_null());
        let observed: Vec<_> = unsafe { std::slice::from_raw_parts(raw, count as usize) }
            .iter()
            .map(|value| unsafe { value.to_string().unwrap() })
            .collect();
        unsafe { LocalFree(Some(windows::Win32::Foundation::HLOCAL(raw.cast()))) };
        assert_eq!(&observed[1..], arguments);
        let manual = format_manual_command(&command, true).unwrap();
        assert!(manual.contains(" -Verb RunAs "));
        assert!(manual.contains("-ArgumentList '"));
        assert!(manual.contains("''$(ignored);&"));
        assert!(manual.contains(r#"\"revision\""#));
    }

    #[test]
    fn windows_elevation_dispatches_once_and_never_prompts_another_account() {
        let mut command = Command::new(r"C:\node.exe");
        command.args(["openclaw.mjs", "gateway", "install"]);
        let calls = Cell::new(0);
        assert_eq!(
            run_with(
                &command,
                || Ok(false),
                |_| {
                    calls.set(calls.get() + 1);
                    Ok(0)
                }
            ),
            Err(ElevationError::NonAdministrator)
        );
        assert_eq!(calls.get(), 0);
        assert_eq!(
            run_with(
                &command,
                || Ok(true),
                |_| {
                    calls.set(calls.get() + 1);
                    Err(ElevationError::Cancelled)
                }
            ),
            Err(ElevationError::Cancelled)
        );
        assert_eq!(calls.get(), 1);
        assert_eq!(
            run_with(
                &command,
                || Ok(true),
                |_| {
                    calls.set(calls.get() + 1);
                    Ok(17)
                }
            ),
            Ok(17)
        );
        assert_eq!(calls.get(), 2);
        assert_eq!(
            shell_error(windows::core::Error::from_hresult(
                windows::core::HRESULT::from_win32(1223)
            )),
            ElevationError::Cancelled
        );
        assert!(matches!(
            shell_error(windows::core::Error::from_hresult(
                windows::core::HRESULT::from_win32(5)
            )),
            ElevationError::Failed(_)
        ));
        for program in ["node.exe", r"C:\openclaw.cmd"] {
            assert!(run_with(
                &Command::new(program),
                || Ok(true),
                |_| panic!("invalid program dispatched")
            )
            .is_err());
        }
        command.env("HOME", r"C:\other-user");
        assert!(run_with(
            &command,
            || Ok(true),
            |_| panic!("environment override dispatched")
        )
        .is_err());
    }

    #[test]
    fn windows_receipt_is_bound_to_original_file_request_and_completion() {
        let fixture = Fixture::new();
        let root = &fixture.0;
        let mut request = Request::create_at(
            &root,
            Path::new(r"C:\runtime\bun.exe"),
            &json!({"revision":"a","definition":"b"}),
        )
        .unwrap();
        let path = request.path.clone();
        let transported: Value = serde_json::from_str(&request.argument_json()).unwrap();
        // Node's receipt boundary compares its native Windows path.join result.
        assert!(!transported["path"].as_str().unwrap().contains('/'));
        assert!(request.read_completed().is_err());
        assert!(fs::remove_file(&path).is_err());
        assert!(fs::rename(path.parent().unwrap(), root.join("moved")).is_err());
        let mut complete = request.pending.clone();
        complete["phase"] = "complete".into();
        complete["install"] = json!({"ok":true});
        for key in ["nonce", "request", "kind", "version"] {
            let mut wrong = complete.clone();
            wrong[key] = "different".into();
            fs::write(&path, wrong.to_string()).unwrap();
            assert!(
                request.read_completed().is_err(),
                "accepted different {key}"
            );
        }
        fs::write(&path, complete.to_string()).unwrap();
        assert_eq!(request.read_completed().unwrap(), complete);
        fs::write(&path, vec![b' '; RECEIPT_LIMIT as usize + 1]).unwrap();
        assert!(request.read_completed().unwrap_err().contains("limit"));
        drop(request);
        assert!(!path.exists());
        assert!(!path.parent().unwrap().exists());
    }

    #[test]
    fn windows_receipt_rejects_redirected_account_state() {
        let fixture = Fixture::new();
        let root = &fixture.0;
        let target = root.join("other-state");
        fs::create_dir_all(&target).unwrap();
        let junction = root.join(".openclaw");
        let output = Command::new("cmd.exe")
            .args(["/d", "/c", "mklink", "/J"])
            .arg(&junction)
            .arg(&target)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let error = Request::create_at(&root, Path::new(r"C:\runtime\bun.exe"), &json!({}))
            .err()
            .unwrap();
        assert!(error.contains("redirected"));
        assert!(!target.join("desktop-runtime-actions").exists());
        fs::remove_dir(junction).unwrap();
    }
}
