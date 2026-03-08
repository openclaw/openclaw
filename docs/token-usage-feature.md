# Token Usage Statistics Feature

## Overview

A comprehensive token usage tracking and visualization system for OpenClaw that provides real-time monitoring of AI token consumption and costs.

## Features

### Core Features
- **Daily Token Tracking**: Monitor token usage across all AI models
- **Cost Analysis**: Track estimated costs based on token usage
- **Model Rankings**: Identify top models by token consumption
- **Trend Analysis**: View usage patterns over time
- **Data Export**: Export usage data in JSON or CSV format

### Dashboard Features
- Real-time data visualization
- Responsive design for desktop and mobile
- Interactive charts and tables
- Automatic data refresh
- Error handling and retry mechanisms

## Installation

### Prerequisites
1. **CodexBar CLI**: Required for token usage data collection
   ```bash
   # Install CodexBar (macOS)
   brew install steipete/tap/codexbar
   
   # Verify installation
   codexbar --version
   ```

2. **Node.js**: v16 or higher
3. **OpenClaw**: Latest version

### Integration

The feature is automatically integrated when you add the token-usage module to your OpenClaw configuration.

## Usage

### Accessing the Dashboard

1. **URL**: Navigate to `/admin/token-usage` in your OpenClaw instance
2. **Authentication**: Uses existing OpenClaw authentication
3. **Permissions**: Admin users only

### API Endpoints

#### Health Check
```bash
GET /api/v1/usage/token/health
```
Check if the token usage service is healthy and CodexBar is available.

#### Daily Usage
```bash
GET /api/v1/usage/token/daily?date=2024-01-15
```
Get token usage statistics for a specific day.

#### Date Range
```bash
GET /api/v1/usage/token/range?startDate=2024-01-01&endDate=2024-01-31
```
Get token usage for a date range.

#### Model Rankings
```bash
GET /api/v1/usage/token/models/rankings?limit=10&period=30d
```
Get top models by token usage.

#### Usage Trend
```bash
GET /api/v1/usage/token/trend?days=30
```
Get token usage trend data.

#### Summary
```bash
GET /api/v1/usage/token/summary?period=30d
```
Get comprehensive usage summary.

#### Data Export
```bash
GET /api/v1/usage/token/export?format=json&startDate=2024-01-01&endDate=2024-01-31
```
Export usage data in JSON or CSV format.

### Dashboard Interface

#### Main Dashboard
- **Today's Stats**: Quick overview of today's token usage and cost
- **Model Rankings**: Table showing top models by token consumption
- **Refresh Button**: Manual data refresh
- **Error Display**: Clear error messages with retry options

#### Data Visualization
- **Token Counts**: Formatted numbers (K, M for thousands/millions)
- **Cost Display**: USD currency format
- **Model Provider Tags**: Color-coded provider labels
- **Usage Percentages**: Visual percentage bars

## Configuration

### Environment Variables
```bash
# Enable/disable token usage feature
TOKEN_USAGE_ENABLED=true

# API prefix (default: /api/v1/usage/token)
TOKEN_USAGE_API_PREFIX=/api/v1/usage/token

# Data retention in days (default: 90)
TOKEN_USAGE_RETENTION_DAYS=90

# Require CodexBar (default: true)
TOKEN_USAGE_REQUIRE_CODEXBAR=true
```

### Integration Configuration
```typescript
// In your OpenClaw configuration
import { integrateTokenUsageStatistics } from './src/token-usage/integration';

const app = express();

// Integrate token usage statistics
integrateTokenUsageStatistics(app, {
  enabled: true,
  apiPrefix: '/api/v1/usage/token',
  requireCodexBar: true,
  dataRetentionDays: 90
});
```

## Data Sources

### Primary Source: CodexBar CLI
- Collects token usage data from AI providers
- Supports multiple providers (OpenAI, Anthropic, etc.)
- Provides cost estimation based on provider pricing

### Data Flow
1. **Collection**: CodexBar CLI collects usage data
2. **Aggregation**: Token usage service aggregates data by day/model
3. **Storage**: Data stored in local SQLite database
4. **API**: RESTful API provides access to aggregated data
5. **Dashboard**: Frontend displays data with real-time updates

## Development

### Project Structure
```
src/token-usage/
├── types/              # TypeScript type definitions
├── services/           # Core business logic
├── api/               # RESTful API endpoints
├── integration.ts     # Integration utilities
└── utils/             # Helper functions

ui/src/ui/components/
└── token-usage-dashboard-simple.ts  # Frontend dashboard
```

### Adding New Features

#### 1. New API Endpoint
```typescript
// Add to src/token-usage/api/routes.ts
router.get('/new-endpoint', async (req, res) => {
  // Implementation
});
```

#### 2. New Dashboard Component
```typescript
// Create new Lit component in ui/src/ui/components/
@customElement('new-component')
export class NewComponent extends LitElement {
  // Implementation
}
```

#### 3. New Data Source
```typescript
// Extend TokenUsageService in src/token-usage/services/
class ExtendedTokenUsageService extends TokenUsageService {
  async fetchNewDataSource() {
    // Implementation
  }
}
```

## Testing

### Unit Tests
```bash
# Run token usage service tests
npm test -- src/token-usage/services/TokenUsageService.test.ts

# Run API tests
npm test -- src/token-usage/api/routes.test.ts
```

### Integration Tests
```bash
# Test API endpoints
curl http://localhost:3000/api/v1/usage/token/health

# Test dashboard access
curl http://localhost:3000/admin/token-usage
```

### Manual Testing
1. **Dashboard Access**: Verify `/admin/token-usage` loads
2. **Data Display**: Verify token counts and costs display correctly
3. **API Responses**: Verify all API endpoints return valid JSON
4. **Error Handling**: Test error scenarios (CodexBar unavailable, etc.)

## Troubleshooting

### Common Issues

#### 1. CodexBar Not Found
```
Error: CodexBar CLI not available
```
**Solution**: Install CodexBar CLI
```bash
brew install steipete/tap/codexbar
```

#### 2. No Data Displayed
```
Dashboard shows "No data available"
```
**Solution**: 
- Verify CodexBar has usage data: `codexbar cost --format json`
- Check API health: `/api/v1/usage/token/health`
- Verify date range has data

#### 3. API Errors
```
HTTP 500 errors from API endpoints
```
**Solution**:
- Check server logs for detailed errors
- Verify database permissions
- Check CodexBar CLI accessibility

#### 4. Dashboard Not Loading
```
Blank page or JavaScript errors
```
**Solution**:
- Check browser console for errors
- Verify frontend assets are served correctly
- Check CORS configuration if using separate domains

### Logging

Enable debug logging for troubleshooting:
```typescript
// In your OpenClaw configuration
process.env.DEBUG = 'token-usage:*';
```

Log files are located at:
- `logs/token-usage.log` - Service logs
- `logs/token-usage-api.log` - API request logs
- `logs/token-usage-error.log` - Error logs

## Performance

### Caching
- Daily aggregates are cached for 5 minutes
- Model rankings are cached for 1 minute
- API responses include cache headers

### Database Optimization
- Indexes on date and model columns
- Automatic data cleanup (90-day retention)
- Batch operations for data aggregation

### Frontend Optimization
- Lazy loading of dashboard components
- Efficient SVG charts (no external dependencies)
- Minimal JavaScript bundle size

## Security

### Authentication
- Uses OpenClaw's existing authentication system
- Dashboard access requires admin privileges
- API endpoints validate user permissions

### Data Protection
- No sensitive data stored (only token counts and costs)
- Data aggregation removes identifiable information
- Export functionality respects data retention policies

### API Security
- Rate limiting on API endpoints
- Input validation and sanitization
- CORS configuration for frontend access

## Monitoring

### Health Checks
```bash
# Manual health check
curl http://localhost:3000/api/v1/usage/token/health

# Expected response
{
  "status": "healthy",
  "service": "token-usage-statistics",
  "timestamp": "2024-01-15T10:30:00Z",
  "dependencies": {
    "codexbar": "available"
  }
}
```

### Metrics
- **API Response Times**: Monitor endpoint performance
- **Data Freshness**: Track last data update time
- **Error Rates**: Monitor API error frequency
- **Usage Patterns**: Track dashboard access patterns

### Alerting
Configure alerts for:
- CodexBar CLI unavailable
- API error rate above threshold
- Data not updated for 24 hours
- Unusual token usage patterns

## Contributing

### Development Workflow
1. Fork the repository
2. Create feature branch: `git checkout -b feature/token-usage-enhancement`
3. Make changes and add tests
4. Submit pull request

### Code Standards
- TypeScript for all new code
- Lit components for frontend
- RESTful API design
- Comprehensive test coverage
- Detailed documentation

### Testing Requirements
- Unit tests for all services
- Integration tests for API endpoints
- End-to-end tests for dashboard
- Performance tests for data aggregation

## License

This feature is part of OpenClaw and is licensed under the same terms as the main project.

## Support

For issues and questions:
1. Check the troubleshooting guide
2. Review OpenClaw documentation
3. Open GitHub issue with detailed description
4. Join OpenClaw community discussions

## Changelog

### v1.0.0 (Initial Release)
- Daily token usage tracking
- Cost estimation and analysis
- Model usage rankings
- Interactive dashboard
- Data export functionality
- RESTful API
- Comprehensive documentation

## Roadmap

### Planned Features
- Real-time WebSocket updates
- Custom alert thresholds
- Advanced analytics and forecasting
- Multi-user support with permissions
- Integration with billing systems
- Mobile app companion

### Performance Improvements
- Database query optimization
- Frontend bundle size reduction
- Caching strategy enhancement
- Parallel data processing

### Integration Enhancements
- Additional data source support
- Plugin architecture for custom providers
- Webhook notifications
- External dashboard integrations