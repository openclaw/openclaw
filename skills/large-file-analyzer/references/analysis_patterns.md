# Large File Analysis Patterns (Enhanced)

## Supported Analysis Types

### 1. User Profile Analysis
- **Demographics**: Age, gender, location, income brackets
- **Segments**: Customer tiers, categories, groups
- **Key Metrics**: Revenue, lifetime value, engagement scores

### 2. Behavior Pattern Analysis  
- **Temporal Patterns**: Activity over time, seasonal trends
- **Interaction Patterns**: Clicks, views, session frequency
- **Conversion Patterns**: Purchase rates, signup completion, funnel analysis

### 3. Marketing Data Analysis (NEW)
- **Customer Segmentation**: RFM analysis, behavioral segments
- **Purchase Behavior**: Channel analysis, product preferences
- **Engagement Metrics**: Activity rates, retention analysis
- **Geographic Distribution**: Regional market analysis
- **Business Insights**: Actionable recommendations

### 4. Data Quality Assessment (ENHANCED)
- **Missing Value Analysis**: Per-column missing rates with percentages
- **Outlier Detection**: Statistical methods (IQR, Z-score)
- **Data Consistency**: Format validation, range checking
- **Data Quality Score**: Overall quality assessment
- **Issue Reporting**: Detailed problem identification

### 5. Summary Statistics
- **Basic Info**: Row count, column names, data types
- **Data Quality**: Missing values, duplicates, outliers
- **Distribution**: Numeric ranges, categorical value counts

## File Format Support

### CSV/TSV
- Auto-detect delimiter
- Handle quoted fields
- Support for large files with streaming
- Chinese character encoding support

### JSON
- Array of objects format
- Line-delimited JSON (NDJSON)
- Nested object flattening

### Excel (.xlsx, .xls)
- Multiple sheet support
- Cell formatting preservation
- Formula evaluation
- Direct pandas integration (no external dependencies required)
- Chinese character support for column names and data

### Plain Text
- Log file parsing
- Custom delimiter support
- Regex-based extraction

## Chunk Processing Strategy

### Optimal Chunk Sizes
- **CSV**: 1000-5000 rows per chunk
- **JSON**: 500-2000 objects per chunk  
- **Excel**: 1000-3000 rows per chunk
- **Text**: 1000-5000 lines per chunk

### Memory Management
- Stream processing (don't load entire file)
- Garbage collection between chunks
- Progress tracking and resumability
- Dynamic chunk sizing based on available memory

## Output Formats

### Structured Results
```json
{
  "analysis_type": "marketing_analysis",
  "total_chunks_processed": 5,
  "file_size_mb": 15.2,
  "processing_time_seconds": 45.2,
  "results": {
    "user_demographics": {...},
    "purchase_behavior": {...},
    "engagement_metrics": {...},
    "geographic_distribution": {...},
    "data_quality": {...},
    "business_insights": [...]
  }
}
```

### Model-Friendly Summaries
- Concise key findings
- Top insights prioritized
- Actionable recommendations
- Statistical confidence indicators
- Business-focused language

## Error Handling

### Common Issues
- **File Too Large**: Split into smaller chunks automatically
- **Corrupted Data**: Skip bad rows/chunks with logging
- **Memory Pressure**: Reduce chunk size dynamically
- **Unsupported Format**: Provide conversion suggestions
- **Encoding Issues**: Auto-detect and handle Chinese characters

### Recovery Strategies
- Checkpoint-based processing
- Partial result return
- Retry with different parameters
- Fallback to basic analysis when advanced features fail