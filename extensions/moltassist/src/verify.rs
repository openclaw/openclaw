// Verify — task completion verification.

use crate::task::{Task, TaskState};

/// Verify a task completed successfully.
pub fn verify_task(task: &mut Task) -> bool {
    if let Some(ref cmd) = task.verify_cmd {
        match std::process::Command::new(if cfg!(windows) { "cmd" } else { "sh" })
            .args(if cfg!(windows) { vec!["/C", cmd.as_str()] } else { vec!["-c", cmd.as_str()] })
            .output()
        {
            Ok(output) => {
                if output.status.success() {
                    task.state = TaskState::Done;
                    task.result = Some(String::from_utf8_lossy(&output.stdout).chars().take(200).collect());
                    true
                } else {
                    task.state = TaskState::Failed;
                    task.error = Some(String::from_utf8_lossy(&output.stderr).chars().take(200).collect());
                    false
                }
            }
            Err(e) => {
                task.state = TaskState::Failed;
                task.error = Some(format!("verify error: {}", e));
                false
            }
        }
    } else {
        // No verify command — trust the executor's result
        task.state == TaskState::Done
    }
}
