// Hide the extra console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    #[cfg(all(windows, not(debug_assertions)))]
    {
        use windows::Win32::System::Console::FreeConsole;
        let _ = unsafe { FreeConsole() };
    }

    openclaw_windows_lib::run()
}
