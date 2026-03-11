// Manifest — parse markdown checklists into tasks.
// Reads any markdown with - [ ] / - [x] checkboxes.

use crate::task::Task;

/// Parse markdown content into a list of tasks.
pub fn parse_markdown(content: &str) -> Vec<Task> {
    let mut tasks = Vec::new();
    let mut current_project = String::new();
    let mut counter = 0u32;

    for line in content.lines() {
        let trimmed = line.trim();

        // Project header: ## PROJECT N: Name  or  ## Name
        if trimmed.starts_with("## PROJECT") {
            if let Some(colon_pos) = trimmed.find(':') {
                current_project = trimmed[colon_pos + 1..].trim().to_string();
            }
            continue;
        }
        if trimmed.starts_with("## ") && !trimmed.starts_with("## #") {
            current_project = trimmed[3..].trim().to_string();
            continue;
        }

        // Checklist: - [ ] or - [x] or - [X]
        let (is_check, is_done) = if trimmed.starts_with("- [ ] ") {
            (true, false)
        } else if trimmed.starts_with("- [x] ") || trimmed.starts_with("- [X] ") {
            (true, true)
        } else {
            (false, false)
        };

        if is_check {
            counter += 1;
            let desc = if trimmed.len() > 6 { trimmed[6..].trim() } else { "" };
            let id = format!("t{:03}", counter);
            let mut task = Task::new(&id, desc, &current_project);
            if is_done {
                task.state = crate::task::TaskState::Done;
                task.result = Some("pre-completed".into());
            }
            tasks.push(task);
        }
    }

    tasks
}

/// Count unique projects in task list.
pub fn count_projects(tasks: &[Task]) -> usize {
    let mut projects = std::collections::HashSet::new();
    for task in tasks {
        if !task.project.is_empty() {
            projects.insert(&task.project);
        }
    }
    projects.len().max(1)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_simple_checklist() {
        let md = "## My Project\n- [ ] Do thing one\n- [x] Already done\n- [ ] Do thing two";
        let tasks = parse_markdown(md);
        assert_eq!(tasks.len(), 3);
        assert_eq!(tasks[0].description, "Do thing one");
        assert_eq!(tasks[0].project, "My Project");
        assert_eq!(tasks[1].state, crate::task::TaskState::Done);
        assert_eq!(tasks[2].description, "Do thing two");
    }

    #[test]
    fn parse_sop_format() {
        let md = "## PROJECT 1: Alpha\n- [ ] First\n- [ ] Second\n## PROJECT 2: Beta\n- [ ] Third";
        let tasks = parse_markdown(md);
        assert_eq!(tasks.len(), 3);
        assert_eq!(tasks[0].project, "Alpha");
        assert_eq!(tasks[2].project, "Beta");
    }

    #[test]
    fn count_projects_works() {
        let md = "## A\n- [ ] T1\n## B\n- [ ] T2\n## A\n- [ ] T3";
        let tasks = parse_markdown(md);
        assert_eq!(count_projects(&tasks), 2);
    }
}
