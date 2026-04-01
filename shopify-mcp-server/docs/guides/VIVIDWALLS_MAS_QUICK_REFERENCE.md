# VividWalls MAS Quick Reference Guide

## Database Connection

```
Host: localhost:54322
Schema: vividwalls_mas
Database: postgres
```

## Essential SQL Commands

### 1. Send Message Between Agents

```sql
SELECT vividwalls_mas.publish_message(
    'workflow-uuid-here',
    'from_agent_name',
    'to_agent_name',
    'task',           -- message_type: task, response, status, escalation, broadcast
    'high',           -- priority: critical, high, medium, low
    'Message Subject',
    '{"key": "value"}'::jsonb  -- message content
);
```

### 2. Get Next Message for Agent

```sql
SELECT * FROM vividwalls_mas.consume_next_message('agent_name');
```

### 3. Update Agent Status

```sql
SELECT vividwalls_mas.update_agent_status(
    'agent_name',
    'busy',           -- status: active, busy, idle, error, maintenance
    75,               -- workload_level (0-100%)
    3,                -- current_tasks
    '{"task": "processing_campaign"}'::jsonb  -- performance_metrics
);
```

### 4. Create Task

```sql
SELECT vividwalls_mas.create_task(
    'workflow-uuid',
    'Task Name',
    'campaign_optimization',  -- task_type
    'assigned_to_agent',
    'requesting_agent',
    'high',                   -- priority
    '{"action": "optimize"}'::jsonb,  -- task_definition
    '{"budget": 5000}'::jsonb         -- task_parameters
);
```

### 5. Record Performance Metrics

```sql
SELECT vividwalls_mas.record_agent_performance(
    'agent_name',
    'response_time',  -- metric_type
    15.5,            -- metric_value
    'minutes',       -- metric_unit
    'hourly',        -- measurement_period
    NOW() - INTERVAL '1 hour',
    NOW()
);
```

## Dashboard Queries

### Agent Status Overview

```sql
SELECT * FROM vividwalls_mas.agent_performance_dashboard;
```

### Active Message Queue

```sql
SELECT * FROM vividwalls_mas.active_message_queue ORDER BY priority, created_at;
```

### Task Dashboard

```sql
SELECT * FROM vividwalls_mas.task_dashboard WHERE status IN ('pending', 'in_progress');
```

### Business KPIs

```sql
SELECT * FROM vividwalls_mas.business_kpis ORDER BY kpi_category;
```

### Campaign Performance

```sql
SELECT * FROM vividwalls_mas.campaign_performance_summary WHERE date_recorded >= CURRENT_DATE - INTERVAL '7 days';
```

## Agent Hierarchy

### Executive Division (Priority 1)

- **business_manager** - Central orchestrator

### Marketing Intelligence Division (Priority 2)

- **marketing_research** - Market analysis & competitor intelligence
- **marketing_campaign** - Campaign strategy & creative direction

### Revenue & Customer Division (Priority 3)

- **shopify_agent** - E-commerce platform management
- **facebook_ads_agent** - Facebook & Instagram advertising
- **instagram_agent** - Instagram marketing & engagement
- **pinterest_agent** - Pinterest marketing & trends

### Operations Division (Priority 4)

- **pictorem_agent** - Product fulfillment & quality control
- **email_marketing_agent** - Email campaigns & automation
- **customer_service_agent** - Customer support & satisfaction

## Common Workflow Patterns

### 1. Campaign Planning Workflow

```sql
-- 1. Research Request
SELECT vividwalls_mas.publish_message(uuid_generate_v4(), 'business_manager', 'marketing_research', 'task', 'high', 'Monthly Research Request', '{"deadline": "2024-01-05"}'::jsonb);

-- 2. Research Response
SELECT vividwalls_mas.publish_message(uuid_generate_v4(), 'marketing_research', 'business_manager', 'response', 'high', 'Research Complete', '{"insights": ["trend1", "trend2"]}'::jsonb);

-- 3. Campaign Brief
SELECT vividwalls_mas.publish_message(uuid_generate_v4(), 'business_manager', 'marketing_campaign', 'task', 'medium', 'Develop Q1 Strategy', '{"budget": 50000}'::jsonb);
```

### 2. Performance Alert Workflow

```sql
-- 1. Alert Detection
SELECT vividwalls_mas.publish_message(uuid_generate_v4(), 'facebook_ads_agent', 'business_manager', 'escalation', 'critical', 'ROAS Below Threshold', '{"current_roas": 2.1, "threshold": 3.0}'::jsonb);

-- 2. Investigation Task
SELECT vividwalls_mas.publish_message(uuid_generate_v4(), 'business_manager', 'facebook_ads_agent', 'task', 'critical', 'Investigate Performance Drop', '{"immediate_action": true}'::jsonb);
```

### 3. Cross-Platform Coordination

```sql
-- Broadcast to all platform agents
SELECT vividwalls_mas.publish_message(uuid_generate_v4(), 'business_manager', 'facebook_ads_agent', 'broadcast', 'medium', 'New Collection Launch', '{"collection": "abstract_art_2024", "launch_date": "2024-01-15"}'::jsonb);
SELECT vividwalls_mas.publish_message(uuid_generate_v4(), 'business_manager', 'instagram_agent', 'broadcast', 'medium', 'New Collection Launch', '{"collection": "abstract_art_2024", "launch_date": "2024-01-15"}'::jsonb);
SELECT vividwalls_mas.publish_message(uuid_generate_v4(), 'business_manager', 'pinterest_agent', 'broadcast', 'medium', 'New Collection Launch', '{"collection": "abstract_art_2024", "launch_date": "2024-01-15"}'::jsonb);
```

## Message Content Examples

### Task Message

```json
{
  "task_type": "campaign_optimization",
  "campaign_id": "fb_campaign_123",
  "optimization_target": "roas",
  "current_performance": {
    "roas": 2.8,
    "spend": 1500,
    "revenue": 4200
  },
  "target_performance": {
    "roas": 3.5,
    "max_spend": 2000
  },
  "deadline": "2024-01-15T18:00:00Z",
  "priority_actions": ["pause_low_performers", "scale_winners"]
}
```

### Response Message

```json
{
  "status": "completed",
  "execution_time_minutes": 45,
  "actions_taken": [
    "Paused 3 underperforming ad sets",
    "Increased budget on top 2 performers by 25%",
    "Updated audience targeting based on recent data"
  ],
  "results": {
    "new_roas": 3.7,
    "cost_reduction": 12.5,
    "performance_improvement": 18.3
  },
  "recommendations": [
    "Monitor performance for next 48 hours",
    "Consider creative refresh for paused ads",
    "Expand successful audience segments"
  ]
}
```

### Status Update

```json
{
  "agent_status": "busy",
  "current_activity": "analyzing_campaign_performance",
  "progress_percentage": 75,
  "eta_completion": "2024-01-10T16:30:00Z",
  "resource_usage": {
    "cpu_percentage": 45,
    "memory_usage": "2.1GB",
    "api_calls_remaining": 850
  },
  "queue_status": {
    "pending_tasks": 2,
    "processing_task": "campaign_optimization_fb_123"
  }
}
```

## Performance Monitoring

### Key Metrics to Track

- **Response Time**: Agent message processing speed
- **Task Completion Rate**: Percentage of tasks completed successfully
- **Quality Score**: Output quality rating (1-100)
- **Error Rate**: Percentage of failed operations
- **Workload Level**: Current agent capacity utilization
- **ROAS**: Return on advertising spend
- **CAC**: Customer acquisition cost
- **Conversion Rate**: Purchase conversion percentage

### Alert Thresholds

- **Critical**: ROAS < 2.0, Response time > 60 minutes
- **High**: ROAS < 2.5, CAC > $50, Response time > 30 minutes
- **Medium**: ROAS < 3.0, Conversion rate < 2%, Response time > 15 minutes
- **Low**: Quality score < 85, Task completion < 90%

## MCP Integration Commands

### Test Connection

```sql
SELECT 'VividWalls MAS Connected!' as status, COUNT(*) as agents FROM vividwalls_mas.agents;
```

### Get System Health

```sql
SELECT
  (SELECT COUNT(*) FROM vividwalls_mas.agents WHERE status = 'active') as active_agents,
  (SELECT COUNT(*) FROM vividwalls_mas.active_message_queue) as pending_messages,
  (SELECT COUNT(*) FROM vividwalls_mas.task_dashboard WHERE status = 'in_progress') as active_tasks,
  (SELECT AVG(workload_level) FROM vividwalls_mas.agent_performance_dashboard) as avg_workload;
```

This reference guide provides all the essential commands and patterns needed to effectively use the VividWalls MAS Message Broker system through the PostgreSQL MCP server.
