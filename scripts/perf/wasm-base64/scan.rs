#![no_std]

#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! { core::arch::wasm32::unreachable() }

#[unsafe(no_mangle)]
pub extern "C" fn scan(pointer: u32, length: u32, attachment: u32) -> f64 {
    let memory_bytes = core::arch::wasm32::memory_size::<0>() * 65536;
    let start = pointer as usize;
    let len = length as usize;
    if attachment > 1 || len == 0 || start > memory_bytes || len > memory_bytes - start {
        return -1.0;
    }
    if attachment == 1 && len % 4 != 0 { return -1.0; }
    // The JS owner initialized this private linear-memory span before the call.
    // The module does not retain slices, mutate memory, or call back into JS.
    let bytes = unsafe { core::slice::from_raw_parts(start as *const u8, len) };
    let mut cleaned: u32 = 0;
    let mut padding: u32 = 0;
    let mut last: u8 = 0;
    let mut whitespace = false;
    for &byte in bytes {
        if byte <= 0x20 {
            if attachment == 1 { return -1.0; }
            whitespace = true;
            continue;
        }
        cleaned += 1;
        if byte == b'=' {
            padding += 1;
            if padding > 2 { return -1.0; }
        } else {
            if padding != 0 { return -1.0; }
            last = match byte {
                b'A'..=b'Z' => byte - b'A',
                b'a'..=b'z' => byte - b'a' + 26,
                b'0'..=b'9' => byte - b'0' + 52,
                b'+' => 62,
                b'/' => 63,
                _ => return -1.0,
            };
        }
    }
    if cleaned == 0 { return -1.0; }
    let remainder = cleaned % 4;
    if remainder != 0 && (padding != 0 || remainder == 1) { return -1.0; }
    let effective_padding = if remainder == 0 { padding } else { 4 - remainder };
    let mask = match effective_padding { 2 => 15, 1 => 3, _ => 0 };
    let decoded = cleaned as u64 * 3 / 4 - padding as u64;
    // A Number avoids BigInt marshalling; the bounded result is exact below 2^53.
    ((decoded + 1) * 4 + u64::from(last & mask == 0) * 2 + u64::from(whitespace)) as f64
}
