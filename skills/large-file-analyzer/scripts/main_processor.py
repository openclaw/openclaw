#!/usr/bin/env python3
"""
Main Processor - Entry point for large file analysis
Handles file format detection and routing to appropriate processors
"""

import os
import sys
import logging
from pathlib import Path

# Add scripts directory to path
script_dir = Path(__file__).parent
sys.path.append(str(script_dir))

try:
    from chunk_processor import ChunkProcessor
    from simple_excel_handler import SimpleExcelHandler
    from data_analyzer import DataAnalyzer
except ImportError as e:
    print(f"Import error: {e}")
    sys.exit(1)

def main():
    if len(sys.argv) < 3:
        print("Usage: python main_processor.py <file_path> <analysis_type>")
        print("Analysis types: user_profile, behavior_patterns, summary")
        sys.exit(1)
    
    file_path = sys.argv[1]
    analysis_type = sys.argv[2]
    
    if not os.path.exists(file_path):
        print(f"Error: File {file_path} does not exist")
        sys.exit(1)
    
    # Initialize processors
    excel_handler = SimpleExcelHandler()
    chunk_processor = ChunkProcessor(max_chunk_size=1000)
    analyzer = DataAnalyzer()
    
    # Detect file format
    file_ext = os.path.splitext(file_path)[1].lower()
    
    if file_ext in ['.xlsx', '.xls']:
        print(f"Detected Excel file: {file_path}")
        print("Converting to CSV for processing...")
        
        # Convert Excel to CSV
        csv_path = excel_handler.excel_to_csv(file_path)
        if not csv_path:
            print("Failed to convert Excel file")
            sys.exit(1)
        
        print(f"Conversion successful: {csv_path}")
        processing_file = csv_path
        
    elif file_ext == '.csv':
        print(f"Detected CSV file: {file_path}")
        processing_file = file_path
        
    else:
        print(f"Unsupported file format: {file_ext}")
        sys.exit(1)
    
    # Process the file
    try:
        print("Starting analysis...")
        results = chunk_processor.process_file(processing_file, analysis_type)
        print("Analysis completed successfully!")
        print("\nResults:")
        print(results)
        
        # Clean up temporary CSV if created
        if file_ext in ['.xlsx', '.xls'] and os.path.exists(csv_path):
            os.remove(csv_path)
            print(f"Cleaned up temporary file: {csv_path}")
            
    except Exception as e:
        print(f"Error during processing: {e}")
        sys.exit(1)

if __name__ == "__main__":
    main()