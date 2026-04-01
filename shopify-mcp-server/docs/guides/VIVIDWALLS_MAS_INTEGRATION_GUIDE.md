# VividWalls MAS Message Broker Integration Guide

## Overview

The VividWalls Multi-Agent System (MAS) Message Broker provides a comprehensive PostgreSQL-based communication infrastructure for seamless inter-agent coordination. This system enables structured messaging, task delegation, performance tracking, and business KPI monitoring across the entire VividWalls agent hierarchy.

## System Architecture

### Database Connection

- **Host**: localhost
- **Port**: 54322
- **Schema**: vividwalls_mas
- **Database**: postgres

### Agent Hierarchy

#### Executive Division

- **business_manager** (Priority 1) - Central orchestrator and strategic overseer

#### Marketing Intelligence Division

- **marketing_research** (Priority 2) - Market analysis and competitor intelligence
- **marketing_campaign** (Priority 2) - Campaign strategy and creative direction

#### Revenue & Customer Division

- **shopify_agent** (Priority 3) - E-commerce platform management
- **facebook_ads_agent** (Priority 3) - Facebook and Instagram advertising
- **instagram_agent** (Priority 3) - Instagram marketing and engagement
- **pinterest_agent** (Priority 3) - Pinterest marketing and trend analysis

#### Operations Division

- **pictorem_agent** (Priority 4) - Product fulfillment and quality control
- **email_marketing_agent** (Priority 4) - Email campaigns and automation
- **customer_service_agent** (Priority 4) - Customer support and satisfaction

## Core Message Broker Functions

### 1. Message Publishing

```sql
SELECT vividwalls_mas.publish_message(
    workflow_id UUID,
    from_agent_name VARCHAR(100),
    to_agent_name VARCHAR(100),
    message_type VARCHAR(50),    -- 'task', 'response', 'status', 'escalation', 'broadcast'
    priority VARCHAR(20),        -- 'critical', 'high', 'medium', 'low'
    subject VARCHAR(255),
    content JSONB,
    business_context JSONB DEFAULT '{}',
    scheduled_for TIMESTAMP DEFAULT NOW()
);
```

### 2. Message Consumption

```sql
SELECT * FROM vividwalls_mas.consume_next_message(
    agent_name VARCHAR(100),
    message_types VARCHAR(50)[] DEFAULT NULL
);
```

### 3. Agent Status Updates

```sql
SELECT vividwalls_mas.update_agent_status(
    agent_name VARCHAR(100),
    status VARCHAR(50),          -- 'active', 'busy', 'idle', 'error', 'maintenance'
    workload_level INTEGER,      -- 0-100 percentage
    current_tasks INTEGER,
    performance_metrics JSONB
);
```

### 4. Task Creation

```sql
SELECT vividwalls_mas.create_task(
    workflow_id UUID,
    task_name VARCHAR(255),
    task_type VARCHAR(100),      -- 'campaign_creation', 'performance_analysis', 'optimization', 'research'
    assigned_to_agent_name VARCHAR(100),
    requested_by_agent_name VARCHAR(100),
    priority VARCHAR(20),
    task_definition JSONB,
    task_parameters JSONB DEFAULT '{}',
    due_date TIMESTAMP DEFAULT NULL,
    dependencies UUID[] DEFAULT NULL
);
```

### 5. Performance Metrics Recording

```sql
SELECT vividwalls_mas.record_agent_performance(
    agent_name VARCHAR(100),
    metric_type VARCHAR(100),
    metric_value NUMERIC(10,4),
    metric_unit VARCHAR(50),
    measurement_period VARCHAR(50),
    period_start TIMESTAMP,
    period_end TIMESTAMP,
    context_data JSONB DEFAULT '{}'
);
```

## Message Types and Formats

### Task Messages

```json
{
  "task_type": "campaign_optimization",
  "priority": "high",
  "parameters": {
    "campaign_id": "fb_campaign_123",
    "optimization_target": "roas",
    "threshold": 3.5
  },
  "deliverables": ["performance_analysis", "optimization_recommendations", "implementation_plan"],
  "deadline": "2024-01-15T18:00:00Z"
}
```

### Response Messages

```json
{
  "status": "completed",
  "results": {
    "roas_improvement": 15.3,
    "cost_reduction": 8.7,
    "actions_taken": [
      "paused_underperforming_ads",
      "increased_budget_top_performers",
      "refined_audience_targeting"
    ]
  },
  "performance_metrics": {
    "processing_time_minutes": 45,
    "quality_score": 94
  }
}
```

### Status Messages

```json
{
  "agent_status": "busy",
  "current_activity": "analyzing_campaign_performance",
  "workload": 75,
  "eta_completion": "2024-01-10T16:30:00Z",
  "resource_usage": {
    "cpu_percentage": 45,
    "memory_usage": "2.1GB"
  }
}
```

## Priority Queue System

Messages are processed based on priority levels:

1. **Critical** - Immediate attention (system failures, crisis response)
2. **High** - Urgent business needs (performance alerts, time-sensitive campaigns)
3. **Medium** - Standard operations (daily tasks, routine optimizations)
4. **Low** - Background tasks (research, maintenance, long-term planning)

## Dashboard Views

### Agent Performance Dashboard

```sql
SELECT * FROM vividwalls_mas.agent_performance_dashboard;
```

### Active Message Queue

```sql
SELECT * FROM vividwalls_mas.active_message_queue;
```

### Task Coordination Dashboard

```sql
SELECT * FROM vividwalls_mas.task_dashboard;
```

### Campaign Performance Summary

```sql
SELECT * FROM vividwalls_mas.campaign_performance_summary;
```

## Workflow Templates

### Monthly Campaign Planning Workflow

1. **Research Report Submission** (marketing_research → business_manager)
2. **Insight Review** (business_manager internal analysis)
3. **Campaign Strategy Development** (business_manager → marketing_campaign)
4. **Budget Approval** (marketing_campaign → business_manager)
5. **Campaign Implementation** (business_manager → platform_agents)
6. **Performance Monitoring** (continuous feedback loop)

### Daily Performance Review Workflow

1. **Data Collection** (platform_agents → business_manager)
2. **Performance Analysis** (business_manager internal)
3. **Optimization Identification** (business_manager analysis)
4. **Implementation** (business_manager → platform_agents)

### Crisis Response Workflow

1. **Crisis Detection** (automated alerts)
2. **Severity Assessment** (business_manager)
3. **Immediate Response** (pause/adjust campaigns)
4. **Root Cause Analysis** (business_manager + relevant agents)
5. **Recovery Implementation** (coordinated response)
6. **Monitoring** (continuous tracking)

## Business KPI Tracking

### Marketing KPIs

- Overall ROAS (target: 3.5+)
- Customer Acquisition Cost (target: <$40)
- Conversion Rate (target: 2.5%+)
- Monthly Revenue Growth (target: 20%+)

### Operational KPIs

- Agent Task Completion Rate (target: 95%+)
- Average Response Time (target: <15 minutes)
- System Uptime (target: 99.9%+)
- Error Rate (target: <2%)

## MCP Integration Examples

### Postgres MCP Server Configuration

```json
{
  "mcpServers": {
    "postgres": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-postgres"],
      "env": {
        "POSTGRES_CONNECTION_STRING": "postgresql://postgres:password@localhost:54322/postgres"
      }
    }
  }
}
```

### Example MCP Queries

#### Publish Task Message

```sql
SELECT vividwalls_mas.publish_message(
  '12345678-1234-1234-1234-123456789012',
  'business_manager',
  'facebook_ads_agent',
  'task',
  'high',
  'Optimize Underperforming Campaigns',
  '{"campaigns": ["campaign_123", "campaign_456"], "target_roas": 3.5, "action": "optimization"}'::jsonb
);
```

#### Get Agent Status

```sql
SELECT agent_name, status, workload_level, current_tasks, last_heartbeat
FROM vividwalls_mas.agent_performance_dashboard
WHERE agent_name = 'facebook_ads_agent';
```

#### Retrieve Pending Tasks

```sql
SELECT task_name, priority, due_date, progress_percentage
FROM vividwalls_mas.task_dashboard
WHERE assigned_to = 'marketing_campaign' AND status = 'pending';
```

## Performance Monitoring

### Real-time Notifications

The system includes PostgreSQL NOTIFY/LISTEN for real-time message queue updates:

```sql
LISTEN agent_message_inserted;
```

### Metrics Collection

Regular performance metrics are automatically collected:

- Message processing times
- Agent response rates
- Task completion statistics
- System resource usage

## Security and Permissions

- Schema-level access control
- Function-based security model
- Audit trail for all message transactions
- Encrypted sensitive data in JSONB fields

## Error Handling and Recovery

### Message Retry Logic

- Automatic retry with exponential backoff
- Maximum retry limits per message type
- Dead letter queue for failed messages

### Agent Health Monitoring

- Heartbeat tracking
- Automatic agent recovery procedures
- Escalation protocols for agent failures

## Setup and Deployment

### 1. Initialize the System

```bash
python setup_vividwalls_mas.py
```

### 2. Verify Installation

```sql
SELECT COUNT(*) FROM vividwalls_mas.agents;
-- Should return 10 agents
```

### 3. Test Message Flow

```sql
-- Send test message
SELECT vividwalls_mas.publish_message(
  uuid_generate_v4(),
  'business_manager',
  'marketing_research',
  'task',
  'medium',
  'Test Communication',
  '{"test": true}'::jsonb
);

-- Consume message
SELECT * FROM vividwalls_mas.consume_next_message('marketing_research');
```

## Next Steps

1. **MCP Server Integration**: Configure postgres MCP server with connection details
2. **n8n Workflow Integration**: Create workflows that utilize message broker functions
3. **Dashboard Development**: Build real-time monitoring interfaces
4. **Agent Implementation**: Develop individual agent logic using the message broker
5. **Performance Optimization**: Monitor and tune system performance
6. **Scaling Considerations**: Plan for horizontal scaling as needed

## Support and Maintenance

- Regular database maintenance and optimization
- Performance monitoring and alerting
- Backup and recovery procedures
- Version control for schema changes
- Documentation updates and training

This message broker system provides the foundation for a robust, scalable multi-agent system that can handle complex business workflows and real-time coordination across the entire VividWalls marketing and operations ecosystem.
