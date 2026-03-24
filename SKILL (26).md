---
name: scheduler
description: Universal temporal orchestration and workflow scheduling. Use for "schedule tasks", "orchestrate workflow", "cron jobs", "pipeline automation", "temporal coordination", or any time-based or dependency-based task execution. Applies to ETL, training pipelines, agents, batch jobs.
---

# SCHEDULER

Universal task scheduling and workflow orchestration.

## Core Pattern

```python
class Scheduler:
    """
    Schedule and orchestrate tasks
    """
    
    def __init__(self):
        self.tasks = {}
        self.schedule = []
        self.running = False
    
    def add_task(self, name, function, schedule_type='once', **schedule_params):
        """
        Add task to scheduler
        
        Args:
            name: Task identifier
            function: Callable to execute
            schedule_type: once, interval, cron, dependency
            schedule_params: Type-specific parameters
        """
        
        self.tasks[name] = {
            'function': function,
            'schedule_type': schedule_type,
            'params': schedule_params,
            'last_run': None,
            'next_run': self._calculate_next_run(schedule_type, schedule_params)
        }
    
    def _calculate_next_run(self, schedule_type, params):
        """Calculate next execution time"""
        
        if schedule_type == 'once':
            return params.get('at', datetime.now())
        
        elif schedule_type == 'interval':
            interval = params.get('interval', timedelta(hours=1))
            return datetime.now() + interval
        
        elif schedule_type == 'cron':
            # Simplified cron parsing
            return self._parse_cron(params.get('cron', '0 * * * *'))
        
        elif schedule_type == 'dependency':
            return None  # Triggered by other task completion
    
    def run(self, duration=None):
        """
        Run scheduler
        
        Args:
            duration: How long to run (None = forever)
        """
        
        self.running = True
        start_time = datetime.now()
        
        while self.running:
            current_time = datetime.now()
            
            # Check if duration exceeded
            if duration and (current_time - start_time) > duration:
                break
            
            # Execute due tasks
            for name, task in self.tasks.items():
                if self._is_due(task, current_time):
                    self._execute_task(name, task)
            
            time.sleep(1)  # Check every second
    
    def _is_due(self, task, current_time):
        """Check if task should run"""
        
        if task['schedule_type'] == 'dependency':
            return self._check_dependencies(task)
        
        return task['next_run'] and current_time >= task['next_run']
    
    def _execute_task(self, name, task):
        """Execute task"""
        
        print(f"Executing task: {name}")
        
        try:
            result = task['function']()
            
            # Update timing
            task['last_run'] = datetime.now()
            
            # Schedule next run
            if task['schedule_type'] == 'interval':
                interval = task['params']['interval']
                task['next_run'] = task['last_run'] + interval
            
            elif task['schedule_type'] == 'once':
                task['next_run'] = None  # Don't repeat
            
            # Trigger dependent tasks
            self._trigger_dependents(name, result)
            
        except Exception as e:
            print(f"Task {name} failed: {e}")
    
    def _trigger_dependents(self, task_name, result):
        """Trigger tasks that depend on this one"""
        
        for name, task in self.tasks.items():
            if task['schedule_type'] == 'dependency':
                dependencies = task['params'].get('depends_on', [])
                if task_name in dependencies:
                    self._execute_task(name, task)
    
    def stop(self):
        """Stop scheduler"""
        self.running = False

# Workflow builder

class WorkflowBuilder:
    """
    Build complex workflows with dependencies
    """
    
    def __init__(self):
        self.scheduler = Scheduler()
        self.workflow = {}
    
    def add_step(self, name, function, depends_on=None):
        """Add workflow step"""
        
        if depends_on:
            self.scheduler.add_task(
                name,
                function,
                schedule_type='dependency',
                depends_on=depends_on
            )
        else:
            self.scheduler.add_task(name, function, schedule_type='once')
        
        self.workflow[name] = {
            'function': function,
            'depends_on': depends_on or []
        }
    
    def execute(self):
        """Execute workflow"""
        
        # Find entry points (no dependencies)
        entry_points = [
            name for name, step in self.workflow.items()
            if not step['depends_on']
        ]
        
        # Trigger entry points
        for name in entry_points:
            task = self.scheduler.tasks[name]
            self.scheduler._execute_task(name, task)

# Specialized schedulers

def cron_scheduler(cron_expression, function):
    """
    Simple cron-style scheduler
    
    Args:
        cron_expression: '0 9 * * *' (9am daily)
        function: Task to run
    """
    
    scheduler = Scheduler()
    scheduler.add_task('cron_task', function, 'cron', cron=cron_expression)
    scheduler.run()

def pipeline_scheduler(pipeline_steps):
    """
    Execute data pipeline
    
    Args:
        pipeline_steps: [
            {'name': 'extract', 'function': extract_fn},
            {'name': 'transform', 'function': transform_fn, 'depends_on': ['extract']},
            {'name': 'load', 'function': load_fn, 'depends_on': ['transform']}
        ]
    """
    
    workflow = WorkflowBuilder()
    
    for step in pipeline_steps:
        workflow.add_step(
            step['name'],
            step['function'],
            step.get('depends_on')
        )
    
    workflow.execute()
```

## Example: Agent Circadian Cycle

```python
# Define tasks
def morning_wake():
    print("Loading yesterday's weights...")
    load_checkpoint()

def day_work():
    print("Agent running...")
    agent.run()

def evening_analysis():
    print("Analyzing trajectories...")
    generate_dataset()

def night_training():
    print("Fine-tuning...")
    train_model()

# Schedule
scheduler = Scheduler()

scheduler.add_task('wake', morning_wake, 'cron', cron='0 6 * * *')  # 6am
scheduler.add_task('work', day_work, 'dependency', depends_on=['wake'])
scheduler.add_task('analysis', evening_analysis, 'cron', cron='0 22 * * *')  # 10pm
scheduler.add_task('training', night_training, 'dependency', depends_on=['analysis'])

# Run forever
scheduler.run()
```

## Example: ETL Pipeline

```python
workflow = WorkflowBuilder()

workflow.add_step('extract', extract_data)
workflow.add_step('clean', clean_data, depends_on=['extract'])
workflow.add_step('transform', transform_data, depends_on=['clean'])
workflow.add_step('load', load_to_db, depends_on=['transform'])

workflow.execute()
```

---

**FIN SKILL**

**🎉 12 PRIMITIVES UNIVERSELLES COMPLÈTES! 🎉**
