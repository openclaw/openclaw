#!/usr/bin/env python3
"""
Data Analyzer - Core analysis logic for large file processing
Handles different data formats and provides analysis capabilities
"""

import pandas as pd
import json
import csv
from typing import Dict, List, Any, Optional
import logging

class DataAnalyzer:
    def __init__(self, max_chunk_size: int = 1000):
        self.max_chunk_size = max_chunk_size
        self.logger = logging.getLogger(__name__)
    
    def analyze_csv_chunk(self, chunk: pd.DataFrame, analysis_type: str = "summary") -> Dict[str, Any]:
        """Analyze a CSV chunk based on analysis type"""
        if analysis_type == "user_profile":
            return self._analyze_user_profile(chunk)
        elif analysis_type == "behavior_patterns":
            return self._analyze_behavior_patterns(chunk)
        elif analysis_type == "summary":
            return self._generate_summary(chunk)
        else:
            return {"error": f"Unknown analysis type: {analysis_type}"}
    
    def _analyze_user_profile(self, df: pd.DataFrame) -> Dict[str, Any]:
        """Analyze user demographics and profile information"""
        profile_analysis = {
            "demographics": {},
            "segments": {},
            "key_metrics": {}
        }
        
        # Common demographic columns to look for
        demographic_cols = ['age', 'gender', 'location', 'city', 'country', 'region']
        found_demographics = [col for col in demographic_cols if col in df.columns]
        
        if found_demographics:
            for col in found_demographics:
                if df[col].dtype == 'object':
                    profile_analysis["demographics"][col] = df[col].value_counts().to_dict()
                else:
                    profile_analysis["demographics"][col] = {
                        "mean": float(df[col].mean()),
                        "median": float(df[col].median()),
                        "std": float(df[col].std())
                    }
        
        # Look for user segments or categories
        segment_cols = ['segment', 'category', 'tier', 'group', 'type']
        found_segments = [col for col in segment_cols if col in df.columns]
        
        if found_segments:
            for col in found_segments:
                profile_analysis["segments"][col] = df[col].value_counts().to_dict()
        
        # Key metrics (revenue, activity, etc.)
        metric_cols = ['revenue', 'spend', 'activity', 'score', 'rating', 'frequency']
        found_metrics = [col for col in metric_cols if col in df.columns]
        
        if found_metrics:
            for col in found_metrics:
                if pd.api.types.is_numeric_dtype(df[col]):
                    profile_analysis["key_metrics"][col] = {
                        "total": float(df[col].sum()),
                        "mean": float(df[col].mean()),
                        "max": float(df[col].max()),
                        "min": float(df[col].min())
                    }
        
        return profile_analysis
    
    def _analyze_behavior_patterns(self, df: pd.DataFrame) -> Dict[str, Any]:
        """Analyze user behavior patterns"""
        behavior_analysis = {
            "temporal_patterns": {},
            "interaction_patterns": {},
            "conversion_patterns": {}
        }
        
        # Temporal patterns (dates, timestamps)
        date_cols = [col for col in df.columns if 'date' in col.lower() or 'time' in col.lower()]
        if date_cols:
            for col in date_cols:
                try:
                    df_dates = pd.to_datetime(df[col], errors='coerce')
                    behavior_analysis["temporal_patterns"][col] = {
                        "earliest": df_dates.min().isoformat() if pd.notna(df_dates.min()) else None,
                        "latest": df_dates.max().isoformat() if pd.notna(df_dates.max()) else None,
                        "unique_days": int(df_dates.dt.date.nunique())
                    }
                except Exception as e:
                    self.logger.warning(f"Could not parse date column {col}: {e}")
        
        # Interaction patterns
        interaction_cols = ['clicks', 'views', 'visits', 'sessions', 'interactions']
        found_interactions = [col for col in interaction_cols if col in df.columns]
        
        if found_interactions:
            for col in found_interactions:
                if pd.api.types.is_numeric_dtype(df[col]):
                    behavior_analysis["interaction_patterns"][col] = {
                        "total": int(df[col].sum()),
                        "average_per_user": float(df[col].mean()),
                        "engagement_rate": float((df[col] > 0).mean())
                    }
        
        # Conversion patterns
        conversion_cols = ['conversion', 'purchase', 'signup', 'completed', 'success']
        found_conversions = [col for col in conversion_cols if col in df.columns]
        
        if found_conversions:
            for col in found_conversions:
                if pd.api.types.is_numeric_dtype(df[col]) or df[col].dtype == 'bool':
                    conversion_rate = float(df[col].mean()) if pd.api.types.is_numeric_dtype(df[col]) else float((df[col] == True).mean())
                    behavior_analysis["conversion_patterns"][col] = {
                        "conversion_rate": conversion_rate,
                        "total_conversions": int(df[col].sum()) if pd.api.types.is_numeric_dtype(df[col]) else int((df[col] == True).sum())
                    }
        
        return behavior_analysis
    
    def _generate_summary(self, df: pd.DataFrame) -> Dict[str, Any]:
        """Generate basic summary statistics"""
        summary = {
            "shape": {"rows": len(df), "columns": len(df.columns)},
            "columns": list(df.columns),
            "data_types": {col: str(df[col].dtype) for col in df.columns},
            "missing_values": {col: int(df[col].isnull().sum()) for col in df.columns},
            "numeric_summary": {},
            "categorical_summary": {}
        }
        
        # Numeric columns summary
        numeric_cols = df.select_dtypes(include=['number']).columns
        if len(numeric_cols) > 0:
            summary["numeric_summary"] = df[numeric_cols].describe().to_dict()
        
        # Categorical columns summary
        categorical_cols = df.select_dtypes(include=['object']).columns
        if len(categorical_cols) > 0:
            cat_summary = {}
            for col in categorical_cols[:5]:  # Limit to first 5 categorical columns
                top_values = df[col].value_counts().head(10).to_dict()
                cat_summary[col] = {
                    "unique_values": int(df[col].nunique()),
                    "top_values": top_values
                }
            summary["categorical_summary"] = cat_summary
        
        return summary
    
    def analyze_json_data(self, data: List[Dict], analysis_type: str = "summary") -> Dict[str, Any]:
        """Analyze JSON data"""
        if not data:
            return {"error": "Empty data"}
        
        # Convert to DataFrame for easier analysis
        try:
            df = pd.DataFrame(data)
            return self.analyze_csv_chunk(df, analysis_type)
        except Exception as e:
            return {"error": f"Could not convert JSON to DataFrame: {e}"}
    
    def merge_chunk_results(self, chunk_results: List[Dict], analysis_type: str) -> Dict[str, Any]:
        """Merge results from multiple chunks"""
        if not chunk_results:
            return {"error": "No chunk results to merge"}
        
        if analysis_type == "summary":
            return self._merge_summary_results(chunk_results)
        elif analysis_type == "user_profile":
            return self._merge_profile_results(chunk_results)
        elif analysis_type == "behavior_patterns":
            return self._merge_behavior_results(chunk_results)
        else:
            # For unknown types, just return the first result
            return chunk_results[0]
    
    def _merge_summary_results(self, results: List[Dict]) -> Dict[str, Any]:
        """Merge summary results from multiple chunks"""
        merged = {
            "total_rows": sum(r.get("shape", {}).get("rows", 0) for r in results),
            "columns": results[0].get("columns", []) if results else [],
            "data_types": results[0].get("data_types", {}) if results else {},
            "missing_values_total": {},
            "numeric_summary_merged": {},
            "categorical_summary_merged": {}
        }
        
        # Merge missing values
        if results and "missing_values" in results[0]:
            for col in results[0]["missing_values"].keys():
                merged["missing_values_total"][col] = sum(
                    r.get("missing_values", {}).get(col, 0) for r in results
                )
        
        return merged
    
    def _merge_profile_results(self, results: List[Dict]) -> Dict[str, Any]:
        """Merge user profile results from multiple chunks"""
        merged = {
            "demographics": {},
            "segments": {},
            "key_metrics": {}
        }
        
        for result in results:
            if "demographics" in result:
                for col, stats in result["demographics"].items():
                    if col not in merged["demographics"]:
                        merged["demographics"][col] = stats
                    else:
                        # For numeric demographics, we can't easily merge without raw data
                        # So we'll note that it's aggregated
                        merged["demographics"][col] = "aggregated_from_multiple_chunks"
            
            if "segments" in result:
                for col, counts in result["segments"].items():
                    if col not in merged["segments"]:
                        merged["segments"][col] = counts
                    else:
                        # Merge counts
                        for key, value in counts.items():
                            merged["segments"][col][key] = merged["segments"][col].get(key, 0) + value
            
            if "key_metrics" in result:
                for col, metrics in result["key_metrics"].items():
                    if col not in merged["key_metrics"]:
                        merged["key_metrics"][col] = metrics
                    else:
                        # Merge metrics (sum totals, recalculate means if possible)
                        merged["key_metrics"][col]["total"] += metrics["total"]
                        # Note: mean recalculation would require more data
        
        return merged
    
    def _merge_behavior_results(self, results: List[Dict]) -> Dict[str, Any]:
        """Merge behavior pattern results from multiple chunks"""
        merged = {
            "temporal_patterns": {},
            "interaction_patterns": {},
            "conversion_patterns": {}
        }
        
        for result in results:
            for pattern_type in ["temporal_patterns", "interaction_patterns", "conversion_patterns"]:
                if pattern_type in result:
                    for col, stats in result[pattern_type].items():
                        if col not in merged[pattern_type]:
                            merged[pattern_type][col] = stats
                        else:
                            # Merge numeric values by summing
                            for key, value in stats.items():
                                if isinstance(value, (int, float)):
                                    merged[pattern_type][col][key] = merged[pattern_type][col].get(key, 0) + value
        
        return merged