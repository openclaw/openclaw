---
description: Guidelines for implementing task management operations
globs: scripts/modules/task-manager.js
alwaysApply: false
---

# Task Management Guidelines

## Task Structure Standards

- **Core Task Properties**:
  - ✅ DO: Include all required properties in each task object
  - ✅ DO: Provide default values for optional properties
  - ❌ DON'T: Add extra properties that aren't in the standard schema

  ```javascript
  // ✅ DO: Follow this structure for task objects
  const task = {
    id: nextId,
    title: "Task title",
    description: "Brief task description",
    status: "pending", // "pending", "in-progress", "done", etc.
    dependencies: [], // Array of task IDs
    priority: "medium", // "high", "medium", "low"
    details: "Detailed implementation instructions",
    testStrategy: "Verification approach",
    subtasks: [] // Array of subtask objects
  };
  ```

- **Subtask Structure**:
  - ✅ DO: Use consistent properties across subtasks
  - ✅ DO: Maintain simple numeric IDs within parent tasks
  - ❌ DON'T: Duplicate parent task properties in subtasks

  ```javascript
  // ✅ DO: Structure subtasks consistently
  const subtask = {
    id: nextSubtaskId, // Simple numeric ID, unique within the parent task
    title: "Subtask title",
    description: "Brief subtask description",
    status: "pending",
    dependencies: [], // Can include numeric IDs (other subtasks) or full task IDs
    details: "Detailed implementation instructions"
  };
  ```

## Task Creation and Parsing

- **ID Management**:
  - ✅ DO: Assign unique sequential IDs to tasks
  - ✅ DO: Calculate the next ID based on existing tasks
  - ❌ DON'T: Hardcode or reuse IDs

  ```javascript
  // ✅ DO: Calculate the next available ID
  const highestId = Math.max(...data.tasks.map(t => t.id));
  const nextTaskId = highestId + 1;
  ```

- **PRD Parsing**:
  - ✅ DO: Extract tasks from PRD documents using AI
  - ✅ DO: Provide clear prompts to guide AI task generation
  - ✅ DO: Validate and clean up AI-generated tasks

  ```javascript
  // ✅ DO: Validate AI responses
  try {
    // Parse the JSON response
    taskData = JSON.parse(jsonContent);
    
    // Check that we have the required fields
    if (!taskData.title || !taskData.description) {
      throw new Error("Missing required fields in the generated task");
    }
  } catch (error) {
    log('error', "Failed to parse AI's response as valid task JSON:", error);
    process.exit(1);
  }
  ```

## Task Updates and Modifications

- **Status Management**:
  - ✅ DO: Provide functions for updating task status
  - ✅ DO: Handle both individual tasks and subtasks
  - ✅ DO: Consider subtask status when updating parent tasks

  ```javascript
  // ✅ DO: Handle status updates for both tasks and subtasks
  async function setTaskStatus(tasksPath, taskIdInput, newStatus) {
    // Check if it's a subtask (e.g., "1.2")
    if (taskIdInput.includes('.')) {
      const [parentId, subtaskId] = taskIdInput.split('.').map(id => parseInt(id, 10));
      
      // Find the parent task and subtask
      const parentTask = data.tasks.find(t => t.id === parentId);
      const subtask = parentTask.subtasks.find(st => st.id === subtaskId);
      
      // Update subtask status
      subtask.status = newStatus;
      
      // Check if all subtasks are done
      if (newStatus === 'done') {
        const allSubtasksDone = parentTask.subtasks.every(st => st.status === 'done');
        if (allSubtasksDone) {
          // Suggest updating parent task
        }
      }
    } else {
      // Handle regular task
      const task = data.tasks.find(t => t.id === parseInt(taskIdInput, 10));
      task.status = newStatus;
      
      // If marking as done, also mark subtasks
      if (newStatus === 'done' && task.subtasks && task.subtasks.length > 0) {
        task.subtasks.forEach(subtask => {
          subtask.status = newStatus;
        });
      }
    }
  }
  ```

- **Task Expansion**:
  - ✅ DO: Use AI to generate detailed subtasks
  - ✅ DO: Consider complexity analysis for subtask counts
  - ✅ DO: Ensure proper IDs for newly created subtasks

  ```javascript
  // ✅ DO: Generate appropriate subtasks based on complexity
  if (taskAnalysis) {
    log('info', `Found complexity analysis for task ${taskId}: Score ${taskAnalysis.complexityScore}/10`);
    
    // Use recommended number of subtasks if available
    if (taskAnalysis.recommendedSubtasks && numSubtasks === CONFIG.defaultSubtasks) {
      numSubtasks = taskAnalysis.recommendedSubtasks;
      log('info', `Using recommended number of subtasks: ${numSubtasks}`);
    }
  }
  ```

## Task File Generation

- **File Formatting**:
  - ✅ DO: Use consistent formatting for task files
  - ✅ DO: Include all task properties in text files
  - ✅ DO: Format dependencies with status indicators

  ```javascript
  // ✅ DO: Use consistent file formatting
  let content = `# Task ID: ${task.id}\n`;
  content += `# Title: ${task.title}\n`;
  content += `# Status: ${task.status || 'pending'}\n`;
  
  // Format dependencies with their status
  if (task.dependencies && task.dependencies.length > 0) {
    content += `# Dependencies: ${formatDependenciesWithStatus(task.dependencies, data.tasks)}\n`;
  } else {
    content += '# Dependencies: None\n';
  }
  ```

- **Subtask Inclusion**:
  - ✅ DO: Include subtasks in parent task files
  - ✅ DO: Use consistent indentation for subtask sections
  - ✅ DO: Display subtask dependencies with proper formatting

  ```javascript
  // ✅ DO: Format subtasks correctly in task files
  if (task.subtasks && task.subtasks.length > 0) {
    content += '\n# Subtasks:\n';
    
    task.subtasks.forEach(subtask => {
      content += `## ${subtask.id}. ${subtask.title} [${subtask.status || 'pending'}]\n`;
      
      // Format subtask dependencies
      if (subtask.dependencies && subtask.dependencies.length > 0) {
        // Format the dependencies
        content += `### Dependencies: ${formattedDeps}\n`;
      } else {
        content += '### Dependencies: None\n';
      }
      
      content += `### Description: ${subtask.description || ''}\n`;
      content += '### Details:\n';
      content += (subtask.details || '').split('\n').map(line => line).join('\n');
      content += '\n\n';
    });
  }
  ```

## Task Listing and Display

- **Filtering and Organization**:
  - ✅ DO: Allow filtering tasks by status
  - ✅ DO: Handle subtask display in lists
  - ✅ DO: Use consistent table formats

  ```javascript
  // ✅ DO: Implement clear filtering and organization
  // Filter tasks by status if specified
  const filteredTasks = statusFilter 
    ? data.tasks.filter(task => 
        task.status && task.status.toLowerCase() === statusFilter.toLowerCase())
    : data.tasks;
  ```

- **Progress Tracking**:
  - ✅ DO: Calculate and display completion statistics
  - ✅ DO: Track both task and subtask completion
  - ✅ DO: Use visual progress indicators

  ```javascript
  // ✅ DO: Track and display progress
  // Calculate completion statistics
  const totalTasks = data.tasks.length;
  const completedTasks = data.tasks.filter(task => 
    task.status === 'done' || task.status === 'completed').length;
  const completionPercentage = totalTasks > 0 ? (completedTasks / totalTasks) * 100 : 0;
  
  // Count subtasks
  let totalSubtasks = 0;
  let completedSubtasks = 0;
  
  data.tasks.forEach(task => {
    if (task.subtasks && task.subtasks.length > 0) {
      totalSubtasks += task.subtasks.length;
      completedSubtasks += task.subtasks.filter(st => 
        st.status === 'done' || st.status === 'completed').length;
    }
  });
  ```

## Complexity Analysis

- **Scoring System**:
  - ✅ DO: Use AI to analyze task complexity
  - ✅ DO: Include complexity scores (1-10)
  - ✅ DO: Generate specific expansion recommendations

  ```javascript
  // ✅ DO: Handle complexity analysis properly
  const report = {
    meta: {
      generatedAt: new Date().toISOString(),
      tasksAnalyzed: tasksData.tasks.length,
      thresholdScore: thresholdScore,
      projectName: tasksData.meta?.projectName || 'Your Project Name',
      usedResearch: useResearch
    },
    complexityAnalysis: complexityAnalysis
  };
  ```

- **Analysis-Based Workflow**:
  - ✅ DO: Use complexity reports to guide task expansion
  - ✅ DO: Prioritize complex tasks for more detailed breakdown
  - ✅ DO: Use expansion prompts from complexity analysis

  ```javascript
  // ✅ DO: Apply complexity analysis to workflow
  // Sort tasks by complexity if report exists, otherwise by ID
  if (complexityReport && complexityReport.complexityAnalysis) {
    log('info', 'Sorting tasks by complexity...');
    
    // Create a map of task IDs to complexity scores
    const complexityMap = new Map();
    complexityReport.complexityAnalysis.forEach(analysis => {
      complexityMap.set(analysis.taskId, analysis.complexityScore);
    });
    
    // Sort tasks by complexity score (high to low)
    tasksToExpand.sort((a, b) => {
      const scoreA = complexityMap.get(a.id) || 0;
      const scoreB = complexityMap.get(b.id) || 0;
      return scoreB - scoreA;
    });
  }
  ```

## Next Task Selection

- **Eligibility Criteria**:
  - ✅ DO: Consider dependencies when finding next tasks
  - ✅ DO: Prioritize by task priority and dependency count
  - ✅ DO: Skip completed tasks

  ```javascript
  // ✅ DO: Use proper task prioritization logic
  function findNextTask(tasks) {
    // Get all completed task IDs
    const completedTaskIds = new Set(
      tasks
        .filter(t => t.status === 'done' || t.status === 'completed')
        .map(t => t.id)
    );
    
    // Filter for pending tasks whose dependencies are all satisfied
    const eligibleTasks = tasks.filter(task => 
      (task.status === 'pending' || task.status === 'in-progress') && 
      task.dependencies && 
      task.dependencies.every(depId => completedTaskIds.has(depId))
    );
    
    // Sort by priority, dependency count, and ID
    const priorityValues = { 'high': 3, 'medium': 2, 'low': 1 };
    
    const nextTask = eligibleTasks.sort((a, b) => {
      // Priority first
      const priorityA = priorityValues[a.priority || 'medium'] || 2;
      const priorityB = priorityValues[b.priority || 'medium'] || 2;
      
      if (priorityB !== priorityA) {
        return priorityB - priorityA; // Higher priority first
      }
      
      // Dependency count next
      if (a.dependencies.length !== b.dependencies.length) {
        return a.dependencies.length - b.dependencies.length; // Fewer dependencies first
      }
      
      // ID last
      return a.id - b.id; // Lower ID first
    })[0];
    
    return nextTask;
  }
  ```

Refer to [`task-manager.js`](mdc:scripts/modules/task-manager.js) for implementation examples and [`new_features.mdc`](mdc:.cursor/rules/new_features.mdc) for integration guidelines. 