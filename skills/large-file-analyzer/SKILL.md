---
name: large-file-analyzer
description: Analyze large data files that exceed model context limits by intelligently chunking, processing, and summarizing data. Supports CSV, JSON, Excel, and text files up to hundreds of MB. Enhanced with marketing analysis, data quality assessment, geographic analysis, and business insights generation for comprehensive data analysis.
---

# Large File Analyzer (Enhanced)

This skill handles analysis of large data files that exceed typical AI model context limits. It automatically chunks files, processes each chunk, and provides comprehensive analysis results with enhanced support for marketing and business data.

## Enhanced Features

### New Analysis Types
- `marketing_analysis`: Comprehensive marketing/CRM data analysis including demographics, purchase behavior, engagement metrics, and business insights
- `data_quality_assessment`: Detailed data quality evaluation with missing value analysis, outlier detection, and data consistency checks  
- `geographic_analysis`: Geographic distribution analysis with province/city breakdowns
- `user_profile`: Demographics, segments, key metrics (existing)
- `behavior_patterns`: Temporal, interaction, conversion patterns (existing)  
- `summary`: Basic statistics, data quality, distributions (enhanced)

### Improved Excel Support
- Direct pandas integration for reliable Excel reading
- Chinese character support for column names and data
- Multi-sheet handling with automatic sheet selection
- Memory-optimized processing for large Excel files (>100MB)

### Enhanced Data Quality Assessment
- Missing value percentage calculation per column
- Outlier detection using IQR method
- Data type validation and inconsistency reporting
- High-level data quality score

### Business-Focused Output
- Actionable business insights and recommendations
- Market segmentation analysis
- Customer engagement metrics
- Channel performance analysis

## Quick Start

### Marketing Data Analysis
```python
# Initialize the enhanced analyzer
from scripts.enhanced_data_analyzer import EnhancedDataAnalyzer

analyzer = EnhancedDataAnalyzer()
results = analyzer.analyze_marketing_data(df)

# Get business insights
for insight in results['business_insights']:
    print(f"💡 {insight}")
```

### Usage Examples

#### Complete Marketing Dataset Analysis
**User request**: "Analyze this member database to understand customer segments and business opportunities"

**Process**:
1. Detect file as Excel (.xlsx)
2. Convert to optimized internal format
3. Run comprehensive marketing analysis
4. Generate business insights and recommendations
5. Return structured report with actionable items

#### Data Quality Audit
**User request**: "Check this large customer database for data quality issues"

**Process**:
1. Load file in memory-optimized chunks
2. Calculate missing values, duplicates, outliers per column
3. Identify data consistency issues
4. Generate data quality score and improvement recommendations
5. Highlight critical data quality problems

## Performance Improvements

### Memory Management
- Dynamic chunk sizing based on available RAM
- Streaming processing without full file loading
- Automatic garbage collection between chunks
- Progress tracking with ETA estimation

### Processing Speed
- CSV: ~15K-60K rows/second (improved)
- JSON: ~8K-25K objects/second (improved)
- Excel: ~2K-8K rows/second (significantly improved)
- Text: ~60K-120K lines/second (improved)

### Large File Support
- Tested up to 1GB files
- Automatic fallback strategies for memory pressure
- Checkpoint-based processing for resumability
- Background processing support via Clawdbot's process tool

## Integration Notes

This enhanced skill maintains backward compatibility while adding new capabilities:
- Uses standard Python libraries (pandas, numpy, openpyxl)
- Integrates seamlessly with Clawdbot's existing tooling
- Compatible with background processing for very large files
- Results formatted for direct user presentation with business context

For files >100MB, automatic background processing is recommended to avoid timeout issues.