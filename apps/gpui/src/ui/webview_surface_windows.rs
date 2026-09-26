use std::{
    ffi::c_void,
    sync::{
        LazyLock,
        atomic::{AtomicUsize, Ordering},
    },
};

use wry::{WebView, WebViewExtWindows};

type Hwnd = *mut c_void;

const GWL_EXSTYLE: i32 = -20;
const WS_EX_LAYERED: isize = 0x0008_0000;
const WS_EX_TRANSPARENT: isize = 0x0000_0020;
const LWA_ALPHA: u32 = 0x0000_0002;
const SW_HIDE: i32 = 0;
const SW_SHOWNOACTIVATE: i32 = 4;
const SWP_NOSIZE: u32 = 0x0001;
const SWP_NOMOVE: u32 = 0x0002;
const SWP_NOZORDER: u32 = 0x0004;
const SWP_NOACTIVATE: u32 = 0x0010;
const SWP_FRAMECHANGED: u32 = 0x0020;

static NEXT_ID: AtomicUsize = AtomicUsize::new(1);
static PROPERTY: LazyLock<Vec<u16>> = LazyLock::new(|| {
    "OpenClaw.WebviewPresentation"
        .encode_utf16()
        .chain(Some(0))
        .collect()
});

#[link(name = "user32")]
unsafe extern "system" {
    #[cfg_attr(target_pointer_width = "32", link_name = "GetWindowLongW")]
    fn GetWindowLongPtrW(window: Hwnd, index: i32) -> isize;
    #[cfg_attr(target_pointer_width = "32", link_name = "SetWindowLongW")]
    fn SetWindowLongPtrW(window: Hwnd, index: i32, value: isize) -> isize;
    fn SetLayeredWindowAttributes(window: Hwnd, color: u32, alpha: u8, flags: u32) -> i32;
    fn SetWindowPos(
        window: Hwnd,
        after: Hwnd,
        x: i32,
        y: i32,
        width: i32,
        height: i32,
        flags: u32,
    ) -> i32;
    fn ShowWindow(window: Hwnd, command: i32) -> i32;
    fn SetPropW(window: Hwnd, name: *const u16, value: *mut c_void) -> i32;
    fn GetPropW(window: Hwnd, name: *const u16) -> *mut c_void;
    fn RemovePropW(window: Hwnd, name: *const u16) -> *mut c_void;
    fn GetFocus() -> Hwnd;
    fn GetParent(window: Hwnd) -> Hwnd;
    fn IsChild(parent: Hwnd, window: Hwnd) -> i32;
    fn SetFocus(window: Hwnd) -> Hwnd;
}

#[link(name = "kernel32")]
unsafe extern "system" {
    fn SetLastError(error: u32);
    fn GetLastError() -> u32;
}

pub(super) struct Mask {
    window: Hwnd,
    generation: usize,
}

impl Mask {
    pub(super) fn attach(view: &WebView) -> Option<Self> {
        let window = view.hwnd().0;
        let generation = unsafe { GetPropW(window, PROPERTY.as_ptr()) } as usize;
        (generation != 0).then_some(Self { window, generation })
    }

    pub(super) fn hide(&self) -> Result<(), String> {
        // Events can outlive wry's DestroyWindow. The OS removes this property
        // on destruction; a recycled HWND must not receive an old callback.
        if unsafe { GetPropW(self.window, PROPERTY.as_ptr()) } as usize == self.generation
            && let Err(error) = mask(self.window, false)
        {
            unsafe { ShowWindow(self.window, SW_HIDE) };
            return Err(error);
        }
        Ok(())
    }
}

pub(super) fn configure(view: &WebView) -> Result<(), String> {
    let window = view.hwnd().0;
    mask(window, false)?;
    let generation = NEXT_ID
        .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |id| id.checked_add(1))
        .map_err(|_| "Webview presentation identity exhausted")?;
    if unsafe { SetPropW(window, PROPERTY.as_ptr(), generation as *mut c_void) } == 0 {
        return Err(last_error("register webview presentation"));
    }
    Ok(())
}

pub(super) fn present(view: &WebView, render: bool, reveal: bool) -> Result<(), String> {
    let window = view.hwnd().0;
    // WebView2 IsVisible=false stops rendering. Keep it true behind a native
    // alpha mask until the document's meaningful-paint frames have completed.
    if let Err(error) = mask(window, render && reveal) {
        unsafe { ShowWindow(window, SW_HIDE) };
        return Err(error);
    }
    unsafe {
        view.controller()
            .SetIsVisible(render)
            .map_err(|error| format!("Could not update WebView2 rendering: {error}"))?;
        let _ = ShowWindow(window, if render { SW_SHOWNOACTIVATE } else { SW_HIDE });
    }
    Ok(())
}

pub(super) fn detach(view: &WebView) {
    // Invalidate callbacks before wry closes the controller and destroys HWND.
    unsafe {
        let _ = RemovePropW(view.hwnd().0, PROPERTY.as_ptr());
    }
}

fn mask(window: Hwnd, reveal: bool) -> Result<(), String> {
    unsafe {
        SetLastError(0);
        let style = GetWindowLongPtrW(window, GWL_EXSTYLE);
        if style == 0 && GetLastError() != 0 {
            return Err(last_error("read webview window style"));
        }
        let updated = if reveal {
            (style | WS_EX_LAYERED) & !WS_EX_TRANSPARENT
        } else {
            style | WS_EX_LAYERED | WS_EX_TRANSPARENT
        };
        if updated != style {
            SetLastError(0);
            if SetWindowLongPtrW(window, GWL_EXSTYLE, updated) == 0 && GetLastError() != 0 {
                return Err(last_error("update webview window style"));
            }
        }
        // Layered child windows are supported on Windows 8+. Alpha zero and
        // WS_EX_TRANSPARENT both pass mouse events to the native placeholder.
        if SetLayeredWindowAttributes(window, 0, if reveal { 255 } else { 0 }, LWA_ALPHA) == 0 {
            return Err(last_error("mask webview window"));
        }
        if updated != style
            && SetWindowPos(
                window,
                std::ptr::null_mut(),
                0,
                0,
                0,
                0,
                SWP_NOSIZE | SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED,
            ) == 0
        {
            return Err(last_error("apply webview window style"));
        }
        if !reveal {
            let focus = GetFocus();
            if focus == window || IsChild(window, focus) != 0 {
                let parent = GetParent(window);
                if !parent.is_null() {
                    let _ = SetFocus(parent);
                }
            }
        }
    }
    Ok(())
}

fn last_error(action: &str) -> String {
    format!("Could not {action}: {}", std::io::Error::last_os_error())
}
