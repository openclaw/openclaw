//! Owns the desktop-only CLI and every process its launcher creates.
use std::io::Read;
use std::process::{Child, Command, Output, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

pub(crate) struct DesktopNodeProcess {
    child: Child,
    output: Receiver<(bool, String)>,
    overflow: Arc<AtomicBool>,
    readers: Vec<JoinHandle<()>>,
    #[cfg(windows)]
    job: windows_job::Job,
}

impl DesktopNodeProcess {
    pub fn spawn(mut command: Command) -> Result<Self, String> {
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        #[cfg(windows)]
        let job = {
            use std::os::windows::process::CommandExt;
            // Job admission precedes any CLI code, including wrapper grandchildren.
            command.creation_flags(0x0000_0004 | 0x0800_0000);
            windows_job::Job::new()?
        };
        let mut child = command
            .spawn()
            .map_err(|error| format!("Could not start desktop sharing: {error}"))?;
        #[cfg(windows)]
        if let Err(error) = job.admit_and_resume(&child) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
        let (sender, output) = mpsc::sync_channel(64);
        let overflow = Arc::new(AtomicBool::new(false));
        let readers = [
            (
                true,
                child
                    .stdout
                    .take()
                    .map(|pipe| Box::new(pipe) as Box<dyn Read + Send>),
            ),
            (
                false,
                child
                    .stderr
                    .take()
                    .map(|pipe| Box::new(pipe) as Box<dyn Read + Send>),
            ),
        ]
        .into_iter()
        .filter_map(|(stdout, pipe)| pipe.map(|pipe| (stdout, pipe)))
        .map(|(stdout, mut pipe)| {
            let sender = sender.clone();
            let overflow = Arc::clone(&overflow);
            thread::spawn(move || {
                let mut chunk = [0; 4096];
                let mut line = Vec::new();
                while let Ok(size) = pipe.read(&mut chunk) {
                    if size == 0 {
                        break;
                    }
                    for byte in &chunk[..size] {
                        if *byte == b'\n' {
                            if sender
                                .try_send((stdout, String::from_utf8_lossy(&line).into_owned()))
                                .is_err()
                            {
                                overflow.store(true, Ordering::SeqCst);
                            }
                            line.clear();
                        } else if line.len() < 16 * 1024 {
                            line.push(*byte);
                        } else {
                            overflow.store(true, Ordering::SeqCst);
                        }
                    }
                }
                if !line.is_empty()
                    && sender
                        .try_send((stdout, String::from_utf8_lossy(&line).into_owned()))
                        .is_err()
                {
                    overflow.store(true, Ordering::SeqCst);
                }
            })
        })
        .collect();
        Ok(Self {
            child,
            output,
            overflow,
            readers,
            #[cfg(windows)]
            job,
        })
    }

    pub fn output(&self) -> impl Iterator<Item = (bool, String)> + '_ {
        self.output.try_iter().take(64)
    }

    pub fn exited(&mut self) -> Result<bool, String> {
        self.child
            .try_wait()
            .map(|exit| exit.is_some())
            .map_err(|error| format!("Could not inspect desktop sharing: {error}"))
    }

    pub fn stop(&mut self) -> Result<(), String> {
        self.child.stdin.take();
        #[cfg(unix)]
        signal_group(self.child.id(), "TERM")?;
        #[cfg(windows)]
        self.job.stop()?;
        let force_at = Instant::now() + Duration::from_secs(30);
        let deadline = force_at + Duration::from_secs(10);
        let mut forced = false;
        loop {
            let leader_done = self.exited()?;
            #[cfg(unix)]
            let tree_done = !signal_group(self.child.id(), "0")?;
            #[cfg(windows)]
            let tree_done = self.job.is_empty()?;
            if leader_done && tree_done && self.readers.iter().all(JoinHandle::is_finished) {
                for reader in self.readers.drain(..) {
                    reader
                        .join()
                        .map_err(|_| "Desktop sharing output did not close cleanly.".to_string())?;
                }
                return Ok(());
            }
            if Instant::now() >= deadline {
                return Err("Desktop sharing could not finish stopping its process tree. No replacement was started.".into());
            }
            if !forced && Instant::now() >= force_at {
                #[cfg(unix)]
                signal_group(self.child.id(), "KILL")?;
                #[cfg(windows)]
                self.job.stop()?;
                forced = true;
            }
            thread::sleep(Duration::from_millis(25));
        }
    }

    pub fn probe(
        command: Command,
        cancelled: impl Fn() -> bool,
        owner: &mut Option<Self>,
    ) -> Result<Option<Output>, String> {
        if cancelled() {
            return Ok(None);
        }
        *owner = Some(Self::spawn(command)?);
        let process = owner.as_mut().expect("owned CLI probe");
        let deadline = Instant::now() + Duration::from_secs(120);
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        let mut bytes = 0;
        let mut drained_after_exit = false;
        loop {
            for (out, line) in process.output() {
                bytes += line.len() + 1;
                if bytes <= 1024 * 1024 {
                    let target = if out { &mut stdout } else { &mut stderr };
                    target.extend_from_slice(line.as_bytes());
                    target.push(b'\n');
                }
            }
            if cancelled() {
                process.stop()?;
                owner.take();
                return Ok(None);
            }
            if bytes > 1024 * 1024 || process.overflow.load(Ordering::SeqCst) {
                process.stop()?;
                owner.take();
                return Err(
                    "Desktop sharing setup returned too much output; no node was started.".into(),
                );
            }
            if let Some(status) = process
                .child
                .try_wait()
                .map_err(|error| error.to_string())?
            {
                if process.readers.iter().all(JoinHandle::is_finished) {
                    if !drained_after_exit {
                        drained_after_exit = true;
                        continue;
                    }
                    process.stop()?;
                    owner.take();
                    return Ok(Some(Output {
                        status,
                        stdout,
                        stderr,
                    }));
                }
            }
            if Instant::now() >= deadline {
                process.stop()?;
                owner.take();
                return Err("The local CLI did not finish preparing desktop sharing. Update the CLI and try again.".into());
            }
            thread::sleep(Duration::from_millis(25));
        }
    }
}

#[cfg(unix)]
fn signal_group(pid: u32, signal: &str) -> Result<bool, String> {
    let signal = match signal {
        "TERM" => libc::SIGTERM,
        "KILL" => libc::SIGKILL,
        "0" => 0,
        _ => unreachable!(),
    };
    let pid = i32::try_from(pid).map_err(|_| "Invalid desktop sharing process identity.")?;
    if pid <= 1 {
        return Err("Invalid desktop sharing process identity.".into());
    }
    // Only the fresh process group assigned by spawn is ever addressed here.
    if unsafe { libc::kill(-pid, signal) } == 0 {
        return Ok(true);
    }
    let error = std::io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ESRCH) {
        return Ok(false);
    }
    // macOS can report EPERM while our exited leader awaits reaping; keep polling.
    if signal == 0 && error.raw_os_error() == Some(libc::EPERM) {
        return Ok(true);
    }
    Err(format!(
        "Desktop sharing process-group access failed; no replacement was started: {error}"
    ))
}

#[cfg(windows)]
mod windows_job {
    use std::ffi::c_void;
    use std::mem::{size_of, size_of_val};
    use std::os::windows::io::AsRawHandle;
    use std::process::Child;
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
    };
    use windows::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectBasicAccountingInformation,
        JobObjectExtendedLimitInformation, QueryInformationJobObject, SetInformationJobObject,
        TerminateJobObject, JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows::Win32::System::Threading::{OpenThread, ResumeThread, THREAD_SUSPEND_RESUME};

    pub(super) struct Job(HANDLE);
    impl Job {
        pub fn new() -> Result<Self, String> {
            // The owned handle is closed on every error path; the child has not started yet.
            let job = Self(
                unsafe { CreateJobObjectW(None, windows::core::PCWSTR::null()) }
                    .map_err(|error| format!("Could not own desktop sharing processes: {error}"))?,
            );
            let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            unsafe {
                SetInformationJobObject(
                    job.0,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const c_void,
                    size_of_val(&info) as u32,
                )
            }
            .map_err(|error| {
                format!("Could not configure desktop sharing process ownership: {error}")
            })?;
            Ok(job)
        }
        pub fn admit_and_resume(&self, child: &Child) -> Result<(), String> {
            let handle = HANDLE(child.as_raw_handle());
            unsafe { AssignProcessToJobObject(self.0, handle) }
                .map_err(|error| format!("Could not admit desktop sharing processes: {error}"))?;
            let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) }
                .map_err(|error| format!("Could not inspect suspended desktop sharing: {error}"))?;
            let mut entry = THREADENTRY32 {
                dwSize: size_of::<THREADENTRY32>() as u32,
                ..Default::default()
            };
            let mut threads = Vec::new();
            let mut next = unsafe { Thread32First(snapshot, &mut entry) };
            while next.is_ok() {
                if entry.th32OwnerProcessID == child.id() {
                    threads.push(entry.th32ThreadID);
                }
                next = unsafe { Thread32Next(snapshot, &mut entry) };
            }
            let _ = unsafe { CloseHandle(snapshot) };
            if threads.len() != 1 {
                return Err(
                    "Could not identify the suspended desktop sharing startup thread.".into(),
                );
            }
            let thread = unsafe { OpenThread(THREAD_SUSPEND_RESUME, false, threads[0]) }.map_err(
                |error| format!("Could not open desktop sharing startup thread: {error}"),
            )?;
            let resumed = unsafe { ResumeThread(thread) };
            let _ = unsafe { CloseHandle(thread) };
            if resumed == u32::MAX {
                return Err("Could not resume desktop sharing after process admission.".into());
            }
            Ok(())
        }
        pub fn stop(&self) -> Result<(), String> {
            unsafe { TerminateJobObject(self.0, 1) }
                .map_err(|error| format!("Could not stop desktop sharing processes: {error}"))
        }
        pub fn is_empty(&self) -> Result<bool, String> {
            let mut info = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
            unsafe {
                QueryInformationJobObject(
                    Some(self.0),
                    JobObjectBasicAccountingInformation,
                    &mut info as *mut _ as *mut c_void,
                    size_of_val(&info) as u32,
                    None,
                )
            }
            .map_err(|error| format!("Could not verify desktop sharing shutdown: {error}"))?;
            Ok(info.ActiveProcesses == 0)
        }
    }
    impl Drop for Job {
        fn drop(&mut self) {
            let _ = unsafe { CloseHandle(self.0) };
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    #[test]
    fn stops_a_real_wrapper_and_its_descendant_before_returning() {
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "sleep 120 & echo $!; wait"]);
        let mut process = DesktopNodeProcess::spawn(command).unwrap();
        let descendant = process
            .output
            .recv_timeout(Duration::from_secs(5))
            .unwrap()
            .1
            .parse::<u32>()
            .unwrap();
        process.stop().unwrap();
        assert!(!signal_group(process.child.id(), "0").unwrap());
        let probe = Command::new("/bin/kill")
            .args(["-0", &descendant.to_string()])
            .output()
            .unwrap();
        assert!(
            !probe.status.success(),
            "wrapper descendant survived shutdown"
        );
        assert!(process.exited().unwrap());
    }
    #[cfg(unix)]
    #[test]
    fn a_noisy_cli_probe_is_cancelled_and_joined_when_its_preparation_is_superseded() {
        let root =
            std::env::temp_dir().join(format!("openclaw-desktop-probe-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let marker = root.join("ready");
        let mut command = Command::new("/bin/sh");
        command
            .args([
                "-c",
                "echo $$ > \"$1\"; while :; do echo diagnostic; done",
                "fixture",
            ])
            .arg(&marker);
        let mut owner = None;
        let result = DesktopNodeProcess::probe(command, || marker.exists(), &mut owner).unwrap();
        assert!(result.is_none());
        assert!(owner.is_none(), "superseded preparation kept a live owner");
        let pid = std::fs::read_to_string(&marker)
            .unwrap()
            .trim()
            .parse::<i32>()
            .unwrap();
        assert_eq!(unsafe { libc::kill(pid, 0) }, -1);
        assert_eq!(
            std::io::Error::last_os_error().raw_os_error(),
            Some(libc::ESRCH)
        );
        std::fs::remove_dir_all(root).unwrap();
    }
    #[cfg(windows)]
    #[test]
    fn job_joins_a_real_command_wrapper_and_its_descendant() {
        use windows::Win32::Foundation::{CloseHandle, STILL_ACTIVE};
        use windows::Win32::System::Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
            TH32CS_SNAPPROCESS,
        };
        use windows::Win32::System::Threading::{
            GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
        };
        let mut command = Command::new("cmd.exe");
        command.args(["/d", "/s", "/c", "ping.exe -n 120 127.0.0.1 >nul"]);
        let mut process = DesktopNodeProcess::spawn(command).unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        // Observe the real cmd wrapper's child without depending on PowerShell startup or stdout.
        let descendant = loop {
            let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) }.unwrap();
            let mut entry = PROCESSENTRY32W {
                dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
                ..Default::default()
            };
            let mut next = unsafe { Process32FirstW(snapshot, &mut entry) };
            let mut descendant = None;
            while next.is_ok() {
                if entry.th32ParentProcessID == process.child.id() {
                    let name_length = entry
                        .szExeFile
                        .iter()
                        .position(|unit| *unit == 0)
                        .unwrap_or(entry.szExeFile.len());
                    if String::from_utf16_lossy(&entry.szExeFile[..name_length])
                        .eq_ignore_ascii_case("ping.exe")
                    {
                        descendant = Some(entry.th32ProcessID);
                        break;
                    }
                }
                next = unsafe { Process32NextW(snapshot, &mut entry) };
            }
            unsafe { CloseHandle(snapshot) }.unwrap();
            if let Some(descendant) = descendant {
                break descendant;
            }
            assert!(
                !process.exited().unwrap(),
                "cmd exited before its child was observed"
            );
            assert!(
                Instant::now() < deadline,
                "cmd did not start ping within the readiness budget"
            );
            thread::sleep(Duration::from_millis(25));
        };
        let handle =
            unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, descendant) }.unwrap();
        let mut code = 0;
        unsafe { GetExitCodeProcess(handle, &mut code) }.unwrap();
        assert_eq!(
            code, STILL_ACTIVE.0 as u32,
            "wrapper child was not alive before shutdown"
        );
        assert!(!process.job.is_empty().unwrap());
        process.stop().unwrap();
        assert!(process.job.is_empty().unwrap());
        assert!(process.exited().unwrap());
        unsafe { GetExitCodeProcess(handle, &mut code) }.unwrap();
        let _ = unsafe { CloseHandle(handle) };
        assert_ne!(
            code, STILL_ACTIVE.0 as u32,
            "wrapper descendant survived Job termination"
        );
    }
}
