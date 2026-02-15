#!/usr/bin/env python3
"""
Chunk Processor - Enhanced version with Excel to CSV conversion
Handles large files by splitting them into manageable chunks
Supports CSV, JSON, Excel, and text formats
"""

import os
import sys
import csv
import json
import tempfile
from typing import List, Dict, Any, Generator, Optional
import logging

# Add the scripts directory to Python path to import our converter
script_dir = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, script_dir)

try:
    from excel_converter import ExcelConverter
    EXCEL_SUPPORT = True
except ImportError as e:
    logging.warning(f"Excel converter not available: {e}")
    EXCEL_SUPPORT = False

class ChunkProcessor:
    def __init__(self, max_chunk_size: int = 1000):
        self.max_chunk_size = max_chunk_size
        self.logger = logging.getLogger(__name__)
        self.temp_files = []
    
    def __del__(self):
        """Cleanup temporary files"""
        for temp_file in self.temp_files:
            try:
                os.unlink(temp_file)
            except OSError:
                pass
    
    def detect_file_format(self, file_path: str) -> str:
        """Detect file format based on extension and content"""
        file_path = file_path.lower()
        
        if file_path.endswith('.csv'):
            return 'csv'
        elif file_path.endswith('.json') or file_path.endswith('.jsonl'):
            return 'json'
        elif file_path.endswith(('.xlsx', '.xls')):
            return 'excel'
        elif file_path.endswith('.txt'):
            return 'text'
        else:
            # Try to detect by content
            try:
                with open(file_path, 'r', encoding='utf-8', errors='ignore') as f:
                    first_line = f.readline()
                    if first_line.startswith('{') or first_line.startswith('['):
                        return 'json'
                    elif ',' in first_line:
                        return 'csv'
                    else:
                        return 'text'
            except:
                return 'unknown'
    
    def process_large_file(self, file_path: str, analysis_type: str = "summary") -> Dict[str, Any]:
        """Main entry point for processing large files"""
        file_format = self.detect_file_format(file_path)
        self.logger.info(f"Detected file format: {file_format} for {file_path}")
        
        if file_format == 'excel':
            return self._process_excel_file(file_path, analysis_type)
        elif file_format == 'csv':
            return self._process_csv_file(file_path, analysis_type)
        elif file_format == 'json':
            return self._process_json_file(file_path, analysis_type)
        elif file_format == 'text':
            return self._process_text_file(file_path, analysis_type)
        else:
            return {"error": f"Unsupported file format: {file_format}"}
    
    def _process_excel_file(self, file_path: str, analysis_type: str) -> Dict[str, Any]:
        """Process Excel file by converting to CSV first"""
        if not EXCEL_SUPPORT:
            return {
                "error": "Excel support not available. Please convert your Excel file to CSV format manually.",
                "suggestion": "Open the Excel file and save as CSV (UTF-8) format, then re-upload."
            }
        
        try:
            # Create temporary CSV file
            temp_csv = tempfile.mktemp(suffix='.csv')
            self.temp_files.append(temp_csv)
            
            # Convert Excel to CSV
            converter = ExcelConverter()
            success = converter.convert_excel_to_csv(file_path, temp_csv)
            
            if not success:
                return {"error": "Failed to convert Excel file to CSV"}
            
            # Process the converted CSV
            result = self._process_csv_file(temp_csv, analysis_type)
            result["original_format"] = "excel"
            result["converted_to_csv"] = True
            
            return result
            
        except Exception as e:
            return {"error": f"Error processing Excel file: {str(e)}"}
    
    def _process_csv_file(self, file_path: str, analysis_type: str) -> Dict[str, Any]:
        """Process CSV file in chunks"""
        try:
            chunk_results = []
            total_rows = 0
            chunk_count = 0
            
            for chunk in self._read_csv_chunks(file_path):
                total_rows += len(chunk)
                chunk_count += 1
                
                # Analyze this chunk
                from data_analyzer import DataAnalyzer
                analyzer = DataAnalyzer()
                chunk_result = analyzer.analyze_csv_chunk(chunk, analysis_type)
                chunk_results.append(chunk_result)
                
                # For very large files, we might want to limit chunks processed
                # but for now, process all chunks
                
            # Merge results from all chunks
            from data_analyzer import DataAnalyzer
            merger = DataAnalyzer()
            final_result = merger.merge_chunk_results(chunk_results, analysis_type)
            
            final_result.update({
                "analysis_type": analysis_type,
                "total_rows_processed": total_rows,
                "total_chunks_processed": chunk_count,
                "file_size_bytes": os.path.getsize(file_path),
                "file_format": "csv"
            })
            
            return final_result
            
        except Exception as e:
            return {"error": f"Error processing CSV file: {str(e)}"}
    
    def _process_json_file(self, file_path: str, analysis_type: str) -> Dict[str, Any]:
        """Process JSON file in chunks"""
        try:
            # For JSON, we'll read line by line for NDJSON, or load entire file if small
            file_size = os.path.getsize(file_path)
            
            if file_size > 100 * 1024 * 1024:  # 100MB
                return {"error": "JSON files larger than 100MB not supported yet"}
            
            with open(file_path, 'r', encoding='utf-8') as f:
                if file_path.endswith('.jsonl'):
                    # Line-delimited JSON
                    data = []
                    for line in f:
                        if line.strip():
                            data.append(json.loads(line))
                else:
                    # Regular JSON array
                    data = json.load(f)
            
            from data_analyzer import DataAnalyzer
            analyzer = DataAnalyzer()
            result = analyzer.analyze_json_data(data, analysis_type)
            
            result.update({
                "analysis_type": analysis_type,
                "total_rows_processed": len(data),
                "file_size_bytes": file_size,
                "file_format": "json"
            })
            
            return result
            
        except Exception as e:
            return {"error": f"Error processing JSON file: {str(e)}"}
    
    def _process_text_file(self, file_path: str, analysis_type: str) -> Dict[str, Any]:
        """Process text file (basic implementation)"""
        try:
            with open(file_path, 'r', encoding='utf-8', errors='ignore') as f:
                lines = f.readlines()
            
            result = {
                "analysis_type": analysis_type,
                "total_lines": len(lines),
                "file_size_bytes": os.path.getsize(file_path),
                "file_format": "text",
                "sample_lines": lines[:5] if len(lines) > 5 else lines
            }
            
            return result
            
        except Exception as e:
            return {"error": f"Error processing text file: {str(e)}"}
    
    def _read_csv_chunks(self, file_path: str) -> Generator[List[Dict], None, None]:
        """Read CSV file in chunks and yield as list of dictionaries"""
        try:
            with open(file_path, 'r', encoding='utf-8', errors='replace') as csvfile:
                # Detect delimiter
                sample = csvfile.read(1024)
                csvfile.seek(0)
                
                sniffer = csv.Sniffer()
                try:
                    delimiter = sniffer.sniff(sample).delimiter
                except:
                    delimiter = ','
                
                reader = csv.DictReader(csvfile, delimiter=delimiter)
                
                chunk = []
                for row in reader:
                    # Clean up empty values
                    cleaned_row = {k: v if v != '' else None for k, v in row.items()}
                    chunk.append(cleaned_row)
                    
                    if len(chunk) >= self.max_chunk_size:
                        yield chunk
                        chunk = []
                
                if chunk:  # Yield remaining rows
                    yield chunk
                    
        except Exception as e:
            self.logger.error(f"Error reading CSV chunks: {e}")
            # Return empty chunk to avoid breaking the pipeline
            yield []

# Test function
def main():
    if len(sys.argv) < 2:
        print("Usage: python chunk_processor.py <file_path> [analysis_type]")
        return
    
    file_path = sys.argv[1]
    analysis_type = sys.argv[2] if len(sys.argv) > 2 else "summary"
    
    processor = ChunkProcessor(max_chunk_size=1000)
    result = processor.process_large_file(file_path, analysis_type)
    
    print(json.dumps(result, indent=2, ensure_ascii=False))

if __name__ == "__main__":
    main()