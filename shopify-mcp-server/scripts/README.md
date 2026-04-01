# Meta-Development Script

This folder contains a **meta-development script** (`dev.js`) and related utilities that manage tasks for an AI-driven or traditional software development workflow. The script revolves around a `tasks.json` file, which holds an up-to-date list of development tasks.

## Overview

In an AI-driven development process—particularly with tools like [Cursor](https://www.cursor.so/)—it's beneficial to have a **single source of truth** for tasks. This script allows you to:

1. **Parse** a PRD or requirements document (`.txt`) to initialize a set of tasks (`tasks.json`).
2. **List** all existing tasks (IDs, statuses, titles).
3. **Update** tasks to accommodate new prompts or architecture changes (useful if you discover "implementation drift").
4. **Generate** individual task files (e.g., `task_001.txt`) for easy reference or to feed into an AI coding workflow.
5. **Set task status**—mark tasks as `done`, `pending`, or `deferred` based on progress.
6. **Expand** tasks with subtasks—break down complex tasks into smaller, more manageable subtasks.
7. **Research-backed subtask generation**—use Perplexity AI to generate more informed and contextually relevant subtasks.
8. **Clear subtasks**—remove subtasks from specified tasks to allow regeneration or restructuring.
9. **Show task details**—display detailed information about a specific task and its subtasks.

## Configuration

The script can be configured through environment variables in a `.env` file at the root of the project:

### Required Configuration

- `ANTHROPIC_API_KEY`: Your Anthropic API key for Claude

### Optional Configuration

- `MODEL`: Specify which Claude model to use (default: "claude-3-7-sonnet-20250219")
- `MAX_TOKENS`: Maximum tokens for model responses (default: 4000)
- `TEMPERATURE`: Temperature for model responses (default: 0.7)
- `PERPLEXITY_API_KEY`: Your Perplexity API key for research-backed subtask generation
- `PERPLEXITY_MODEL`: Specify which Perplexity model to use (default: "sonar-medium-online")
- `DEBUG`: Enable debug logging (default: false)
- `LOG_LEVEL`: Log level - debug, info, warn, error (default: info)
- `DEFAULT_SUBTASKS`: Default number of subtasks when expanding (default: 3)
- `DEFAULT_PRIORITY`: Default priority for generated tasks (default: medium)
- `PROJECT_NAME`: Override default project name in tasks.json
- `PROJECT_VERSION`: Override default version in tasks.json

## How It Works

1. **`tasks.json`**:
   - A JSON file at the project root containing an array of tasks (each with `id`, `title`, `description`, `status`, etc.).
   - The `meta` field can store additional info like the project's name, version, or reference to the PRD.
   - Tasks can have `subtasks` for more detailed implementation steps.
   - Dependencies are displayed with status indicators (✅ for completed, ⏱️ for pending) to easily track progress.

2. **CLI Commands**  
   You can run the commands via:

   ```bash
   # If installed globally
   task-master [command] [options]

   # If using locally within the project
   node scripts/dev.js [command] [options]
   ```

   Available commands:
   - `init`: Initialize a new project
   - `parse-prd`: Generate tasks from a PRD document
   - `list`: Display all tasks with their status
   - `update`: Update tasks based on new information
   - `generate`: Create individual task files
   - `set-status`: Change a task's status
   - `expand`: Add subtasks to a task or all tasks
   - `clear-subtasks`: Remove subtasks from specified tasks
   - `next`: Determine the next task to work on based on dependencies
   - `show`: Display detailed information about a specific task
   - `analyze-complexity`: Analyze task complexity and generate recommendations
   - `complexity-report`: Display the complexity analysis in a readable format
   - `add-dependency`: Add a dependency between tasks
   - `remove-dependency`: Remove a dependency from a task
   - `validate-dependencies`: Check for invalid dependencies
   - `fix-dependencies`: Fix invalid dependencies automatically
   - `add-task`: Add a new task using AI

   Run `task-master --help` or `node scripts/dev.js --help` to see detailed usage information.

## Listing Tasks

The `list` command allows you to view all tasks and their status:

```bash
# List all tasks
task-master list

# List tasks with a specific status
task-master list --status=pending

# List tasks and include their subtasks
task-master list --with-subtasks

# List tasks with a specific status and include their subtasks
task-master list --status=pending --with-subtasks
```

## Updating Tasks

The `update` command allows you to update tasks based on new information or implementation changes:

```bash
# Update tasks starting from ID 4 with a new prompt
task-master update --from=4 --prompt="Refactor tasks from ID 4 onward to use Express instead of Fastify"

# Update all tasks (default from=1)
task-master update --prompt="Add authentication to all relevant tasks"

# Specify a different tasks file
task-master update --file=custom-tasks.json --from=5 --prompt="Change database from MongoDB to PostgreSQL"
```

Notes:

- The `--prompt` parameter is required and should explain the changes or new context
- Only tasks that aren't marked as 'done' will be updated
- Tasks with ID >= the specified --from value will be updated

## Setting Task Status

The `set-status` command allows you to change a task's status:

```bash
# Mark a task as done
task-master set-status --id=3 --status=done

# Mark a task as pending
task-master set-status --id=4 --status=pending

# Mark a specific subtask as done
task-master set-status --id=3.1 --status=done

# Mark multiple tasks at once
task-master set-status --id=1,2,3 --status=done
```

Notes:

- When marking a parent task as "done", all of its subtasks will automatically be marked as "done" as well
- Common status values are 'done', 'pending', and 'deferred', but any string is accepted
- You can specify multiple task IDs by separating them with commas
- Subtask IDs are specified using the format `parentId.subtaskId` (e.g., `3.1`)
- Dependencies are updated to show completion status (✅ for completed, ⏱️ for pending) throughout the system

## Expanding Tasks

The `expand` command allows you to break down tasks into subtasks for more detailed implementation:

```bash
# Expand a specific task with 3 subtasks (default)
task-master expand --id=3

# Expand a specific task with 5 subtasks
task-master expand --id=3 --num=5

# Expand a task with additional context
task-master expand --id=3 --prompt="Focus on security aspects"

# Expand all pending tasks that don't have subtasks
task-master expand --all

# Force regeneration of subtasks for all pending tasks
task-master expand --all --force

# Use Perplexity AI for research-backed subtask generation
task-master expand --id=3 --research

# Use Perplexity AI for research-backed generation on all pending tasks
task-master expand --all --research
```

## Clearing Subtasks

The `clear-subtasks` command allows you to remove subtasks from specified tasks:

```bash
# Clear subtasks from a specific task
task-master clear-subtasks --id=3

# Clear subtasks from multiple tasks
task-master clear-subtasks --id=1,2,3

# Clear subtasks from all tasks
task-master clear-subtasks --all
```

Notes:

- After clearing subtasks, task files are automatically regenerated
- This is useful when you want to regenerate subtasks with a different approach
- Can be combined with the `expand` command to immediately generate new subtasks
- Works with both parent tasks and individual subtasks

## AI Integration

The script integrates with two AI services:

1. **Anthropic Claude**: Used for parsing PRDs, generating tasks, and creating subtasks.
2. **Perplexity AI**: Used for research-backed subtask generation when the `--research` flag is specified.

The Perplexity integration uses the OpenAI client to connect to Perplexity's API, which provides enhanced research capabilities for generating more informed subtasks. If the Perplexity API is unavailable or encounters an error, the script will automatically fall back to using Anthropic's Claude.

To use the Perplexity integration:

1. Obtain a Perplexity API key
2. Add `PERPLEXITY_API_KEY` to your `.env` file
3. Optionally specify `PERPLEXITY_MODEL` in your `.env` file (default: "sonar-medium-online")
4. Use the `--research` flag with the `expand` command

## Logging

The script supports different logging levels controlled by the `LOG_LEVEL` environment variable:

- `debug`: Detailed information, typically useful for troubleshooting
- `info`: Confirmation that things are working as expected (default)
- `warn`: Warning messages that don't prevent execution
- `error`: Error messages that might prevent execution

When `DEBUG=true` is set, debug logs are also written to a `dev-debug.log` file in the project root.

## Managing Task Dependencies

The `add-dependency` and `remove-dependency` commands allow you to manage task dependencies:

```bash
# Add a dependency to a task
task-master add-dependency --id=<id> --depends-on=<id>

# Remove a dependency from a task
task-master remove-dependency --id=<id> --depends-on=<id>
```

These commands:

1. **Allow precise dependency management**:
   - Add dependencies between tasks with automatic validation
   - Remove dependencies when they're no longer needed
   - Update task files automatically after changes

2. **Include validation checks**:
   - Prevent circular dependencies (a task depending on itself)
   - Prevent duplicate dependencies
   - Verify that both tasks exist before adding/removing dependencies
   - Check if dependencies exist before attempting to remove them

3. **Provide clear feedback**:
   - Success messages confirm when dependencies are added/removed
   - Error messages explain why operations failed (if applicable)

4. **Automatically update task files**:
   - Regenerates task files to reflect dependency changes
   - Ensures tasks and their files stay synchronized

## Dependency Validation and Fixing

The script provides two specialized commands to ensure task dependencies remain valid and properly maintained:

### Validating Dependencies

The `validate-dependencies` command allows you to check for invalid dependencies without making changes:

```bash
# Check for invalid dependencies in tasks.json
task-master validate-dependencies

# Specify a different tasks file
task-master validate-dependencies --file=custom-tasks.json
```

This command:

- Scans all tasks and subtasks for non-existent dependencies
- Identifies potential self-dependencies (tasks referencing themselves)
- Reports all found issues without modifying files
- Provides a comprehensive summary of dependency state
- Gives detailed statistics on task dependencies

Use this command to audit your task structure before applying fixes.

### Fixing Dependencies

The `fix-dependencies` command proactively finds and fixes all invalid dependencies:

```bash
# Find and fix all invalid dependencies
task-master fix-dependencies

# Specify a different tasks file
task-master fix-dependencies --file=custom-tasks.json
```

This command:

1. **Validates all dependencies** across tasks and subtasks
2. **Automatically removes**:
   - References to non-existent tasks and subtasks
   - Self-dependencies (tasks depending on themselves)
3. **Fixes issues in both**:
   - The tasks.json data structure
   - Individual task files during regeneration
4. **Provides a detailed report**:
   - Types of issues fixed (non-existent vs. self-dependencies)
   - Number of tasks affected (tasks vs. subtasks)
   - Where fixes were applied (tasks.json vs. task files)
   - List of all individual fixes made

This is especially useful when tasks have been deleted or IDs have changed, potentially breaking dependency chains.

## Analyzing Task Complexity

The `analyze-complexity` command allows you to automatically assess task complexity and generate expansion recommendations:

```bash
# Analyze all tasks and generate expansion recommendations
task-master analyze-complexity

# Specify a custom output file
task-master analyze-complexity --output=custom-report.json

# Override the model used for analysis
task-master analyze-complexity --model=claude-3-opus-20240229

# Set a custom complexity threshold (1-10)
task-master analyze-complexity --threshold=6

# Use Perplexity AI for research-backed complexity analysis
task-master analyze-complexity --research
```

Notes:

- The command uses Claude to analyze each task's complexity (or Perplexity with --research flag)
- Tasks are scored on a scale of 1-10
- Each task receives a recommended number of subtasks based on DEFAULT_SUBTASKS configuration
- The default output path is `scripts/task-complexity-report.json`
- Each task in the analysis includes a ready-to-use `expansionCommand` that can be copied directly to the terminal or executed programmatically
- Tasks with complexity scores below the threshold (default: 5) may not need expansion
- The research flag provides more contextual and informed complexity assessments

### Integration with Expand Command

The `expand` command automatically checks for and uses complexity analysis if available:

```bash
# Expand a task, using complexity report recommendations if available
task-master expand --id=8

# Expand all tasks, prioritizing by complexity score if a report exists
task-master expand --all

# Override recommendations with explicit values
task-master expand --id=8 --num=5 --prompt="Custom prompt"
```

When a complexity report exists:

- The `expand` command will use the recommended subtask count from the report (unless overridden)
- It will use the tailored expansion prompt from the report (unless a custom prompt is provided)
- When using `--all`, tasks are sorted by complexity score (highest first)
- The `--research` flag is preserved from the complexity analysis to expansion

The output report structure is:

```json
{
  "meta": {
    "generatedAt": "2023-06-15T12:34:56.789Z",
    "tasksAnalyzed": 20,
    "thresholdScore": 5,
    "projectName": "Your Project Name",
    "usedResearch": true
  },
  "complexityAnalysis": [
    {
      "taskId": 8,
      "taskTitle": "Develop Implementation Drift Handling",
      "complexityScore": 9.5,
      "recommendedSubtasks": 6,
      "expansionPrompt": "Create subtasks that handle detecting...",
      "reasoning": "This task requires sophisticated logic...",
      "expansionCommand": "task-master expand --id=8 --num=6 --prompt=\"Create subtasks...\" --research"
    }
    // More tasks sorted by complexity score (highest first)
  ]
}
```

## Finding the Next Task

The `next` command helps you determine which task to work on next based on dependencies and status:

```bash
# Show the next task to work on
task-master next

# Specify a different tasks file
task-master next --file=custom-tasks.json
```

This command:

1. Identifies all **eligible tasks** - pending or in-progress tasks whose dependencies are all satisfied (marked as done)
2. **Prioritizes** these eligible tasks by:
   - Priority level (high > medium > low)
   - Number of dependencies (fewer dependencies first)
   - Task ID (lower ID first)
3. **Displays** comprehensive information about the selected task:
   - Basic task details (ID, title, priority, dependencies)
   - Detailed description and implementation details
   - Subtasks if they exist
4. Provides **contextual suggested actions**:
   - Command to mark the task as in-progress
   - Command to mark the task as done when completed
   - Commands for working with subtasks (update status or expand)

This feature ensures you're always working on the most appropriate task based on your project's current state and dependency structure.

## Showing Task Details

The `show` command allows you to view detailed information about a specific task:

```bash
# Show details for a specific task
task-master show 1

# Alternative syntax with --id option
task-master show --id=1

# Show details for a subtask
task-master show --id=1.2

# Specify a different tasks file
task-master show 3 --file=custom-tasks.json
```

This command:

1. **Displays comprehensive information** about the specified task:
   - Basic task details (ID, title, priority, dependencies, status)
   - Full description and implementation details
   - Test strategy information
   - Subtasks if they exist
2. **Handles both regular tasks and subtasks**:
   - For regular tasks, shows all subtasks and their status
   - For subtasks, shows the parent task relationship
3. **Provides contextual suggested actions**:
   - Commands to update the task status
   - Commands for working with subtasks
   - For subtasks, provides a link to view the parent task

This command is particularly useful when you need to examine a specific task in detail before implementing it or when you want to check the status and details of a particular task.
