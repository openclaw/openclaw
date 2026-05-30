use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub struct AuthRateLimiter {
    attempts: Mutex<HashMap<String, Vec<Instant>>>,
    max_attempts: u32,
    window: Duration,
}

impl AuthRateLimiter {
    pub fn new(max_attempts: u32, window_secs: u64) -> Self {
        Self {
            attempts: Mutex::new(HashMap::new()),
            max_attempts,
            window: Duration::from_secs(window_secs),
        }
    }

    pub fn check(&self, key: &str) -> Result<(), Duration> {
        let mut attempts = self.attempts.lock().unwrap();
        let now = Instant::now();

        let ip_attempts = attempts.entry(key.to_string()).or_insert_with(|| Vec::new());
        ip_attempts.retain(|&t| now.duration_since(t) < self.window);

        if ip_attempts.len() >= self.max_attempts as usize {
            let oldest = ip_attempts[0];
            let retry_after = self.window.saturating_sub(now.duration_since(oldest));
            return Err(retry_after);
        }

        Ok(())
    }

    pub fn record_failure(&self, key: &str) {
        let mut attempts = self.attempts.lock().unwrap();
        attempts.entry(key.to_string()).or_insert_with(|| Vec::new()).push(Instant::now());
    }

    pub fn reset(&self, key: &str) {
        let mut attempts = self.attempts.lock().unwrap();
        attempts.remove(key);
    }
}

/// Constant-time string comparison to prevent timing attacks.
pub fn safe_equal(a: &str, b: &str) -> bool {
    let a_bytes = a.as_bytes();
    let b_bytes = b.as_bytes();

    if a_bytes.len() != b_bytes.len() {
        return false;
    }

    let mut result = 0u8;
    for (x, y) in a_bytes.iter().zip(b_bytes.iter()) {
        result |= x ^ y;
    }
    result == 0
}
