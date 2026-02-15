# File Format Handling Guide

## CSV/TSV Processing

### Detection and Parsing
- Auto-detect delimiter (comma, tab, semicolon, pipe)
- Handle quoted fields with embedded delimiters
- Support for different encodings (UTF-8, Latin-1, etc.)
- Header detection and validation
- **Enhanced support for Chinese characters and special encodings**

### Large CSV Optimization
```python
# Use chunksize parameter for pandas
pd.read_csv('large_file.csv', chunksize=1000)

# Specify dtypes to reduce memory usage
dtype_dict = {'id': 'int32', 'name': 'category'}

# Use only needed columns
usecols = ['user_id', 'timestamp', 'action']

# Handle encoding issues
encoding = 'utf-8-sig'  # Handle BOM
```

### Common Issues
- **Inconsistent quoting**: Use `quoting=csv.QUOTE_MINIMAL`
- **Mixed data types**: Specify dtypes explicitly
- **Memory overflow**: Process in smaller chunks
- **Encoding problems**: Auto-detect and fallback strategies

## JSON Processing

### Supported Formats
1. **Array of Objects**: `[{"id": 1}, {"id": 2}]`
2. **Line-delimited JSON**: `{"id": 1}\n{"id": 2}`
3. **Nested Objects**: Automatic flattening with dot notation

### Large JSON Optimization
```python
# Stream processing for line-delimited JSON
def process_json_lines(filename):
    with open(filename, 'r', encoding='utf-8') as f:
        for line in f:
            yield json.loads(line)

# For array JSON, use ijson for streaming
import ijson
for item in ijson.items(open('large.json', 'rb'), 'item'):
    process(item)
```

### Memory Considerations
- Avoid loading entire JSON into memory
- Use generators for processing
- Flatten nested structures early
- Handle encoding issues gracefully

## Excel Processing (Enhanced)

### Library Choices
- **openpyxl**: For .xlsx files (default, enhanced with Chinese support)
- **xlrd**: For .xls files (legacy)
- **pandas**: High-level interface with direct Excel reading
- **xlsx2csv**: Command-line tool for performance optimization

### Large Excel Optimization
```python
# Read specific sheets only
pd.read_excel('file.xlsx', sheet_name='Sheet1')

# Use converters for specific columns
converters = {'date_col': pd.to_datetime}

# Skip rows if needed
skiprows = 10  # Skip header rows

# Handle Chinese column names
df = pd.read_excel('chinese_data.xlsx', engine='openpyxl')
```

### Enhanced Features
- **Direct pandas integration** for reliable Excel reading
- **Chinese character support** for column names and data
- **Multi-sheet handling** with automatic sheet selection
- **Memory-optimized processing** for large Excel files (>100MB)
- **Data quality assessment** with missing value analysis

### Limitations and Solutions
- Excel files are memory-intensive → Use chunked processing
- Consider converting to CSV first for very large files → Built-in conversion
- Maximum row limit: ~1M rows per sheet → Handle gracefully

## Text File Processing

### Log File Patterns
- **Timestamp parsing**: Extract and normalize dates
- **Field extraction**: Regex patterns for structured data
- **Error detection**: Identify malformed lines
- **Chinese text support**: Proper encoding handling

### Custom Delimiters
```python
# Custom delimiter processing
def process_custom_delimited(file_path, delimiter='|'):
    with open(file_path, 'r', encoding='utf-8', errors='ignore') as f:
        for line in f:
            fields = line.strip().split(delimiter)
            yield fields
```

### Encoding Handling
- Auto-detect encoding using `chardet`
- Fallback to UTF-8 with error handling
- Support for BOM (Byte Order Mark)
- **Enhanced Chinese encoding support** (GBK, GB2312, UTF-8)

## Performance Benchmarks (Updated)

### Processing Speed (Approximate)
- **CSV**: 15,000-60,000 rows/second (improved)
- **JSON**: 8,000-25,000 objects/second (improved)
- **Excel**: 2,000-8,000 rows/second (significantly improved)
- **Text**: 60,000-120,000 lines/second (improved)

### Memory Usage
- **CSV**: ~2x file size in memory
- **JSON**: ~3x file size in memory
- **Excel**: ~3x file size in memory (optimized)
- **Text**: ~1.5x file size in memory

## Best Practices

### General Guidelines
1. **Always validate file format first**
2. **Process in chunks smaller than available RAM**
3. **Use appropriate data types to minimize memory**
4. **Handle encoding issues gracefully**
5. **Provide progress feedback for large files**
6. **Support international character sets** (Chinese, Japanese, etc.)

### Error Recovery
- Log problematic rows/chunks
- Continue processing after errors when possible
- Provide summary of skipped/failed items
- Offer retry options with different parameters
- **Graceful degradation** for unsupported features

## Marketing Data Specific Features

### Enhanced Analysis Types
- **marketing_analysis**: Comprehensive marketing/CRM data analysis
- **data_quality_assessment**: Detailed data quality evaluation
- **geographic_analysis**: Geographic distribution analysis
- **business_insights**: Actionable business recommendations

### Data Quality Assessment
- Missing value percentage calculation per column
- Outlier detection using IQR method
- Data type validation and inconsistency reporting
- High-level data quality score

### Business-Focused Output
- Actionable business insights and recommendations
- Market segmentation analysis
- Customer engagement metrics
- Channel performance analysis