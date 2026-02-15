#!/usr/bin/env python3
"""
Enhanced member data analysis script using the improved large-file-analyzer plugin
"""

import os
import sys
import json
import pandas as pd
from pathlib import Path

# Add the scripts directory to Python path
script_dir = Path(__file__).parent
sys.path.insert(0, str(script_dir))

from enhanced_data_analyzer import EnhancedDataAnalyzer

def main():
    if len(sys.argv) < 2:
        print("Usage: python analyze_member_data.py <excel_file_path> [analysis_type]")
        print("Analysis types: marketing_analysis (default), data_quality_assessment, user_profile")
        sys.exit(1)
    
    excel_file = sys.argv[1]
    analysis_type = sys.argv[2] if len(sys.argv) > 2 else "marketing_analysis"
    
    if not os.path.exists(excel_file):
        print(f"Error: File {excel_file} does not exist")
        sys.exit(1)
    
    print(f"Analyzing Excel file: {excel_file}")
    
    try:
        # Read Excel file
        print("Reading Excel file...")
        df = pd.read_excel(excel_file)
        print(f"Loaded {len(df)} rows and {len(df.columns)} columns")
        
        # Perform analysis
        print("Performing comprehensive marketing analysis...")
        analyzer = EnhancedDataAnalyzer()
        
        if analysis_type == "marketing_analysis":
            results = analyzer.analyze_marketing_data(df)
        elif analysis_type == "data_quality_assessment":
            results = {"data_quality": analyzer._assess_data_quality(df)}
        elif analysis_type == "user_profile":
            results = {"user_demographics": analyzer._analyze_demographics(df)}
        else:
            results = analyzer.analyze_marketing_data(df)
        
        # Save results to JSON file
        output_file = f"{Path(excel_file).stem}_analysis_results.json"
        with open(output_file, 'w', encoding='utf-8') as f:
            json.dump(results, f, indent=2, ensure_ascii=False)
        
        print(f"Analysis completed! Results saved to {output_file}")
        
        # Print key insights
        print("\n" + "="*60)
        print("KEY BUSINESS INSIGHTS")
        print("="*60)
        for insight in results.get('business_insights', []):
            print(f"💡 {insight}")
        
        # Print data quality summary
        if 'data_quality' in results:
            print("\n" + "="*60)
            print("DATA QUALITY SUMMARY")
            print("="*60)
            for issue in results['data_quality'].get('potential_issues', []):
                print(f"⚠️  {issue}")
        
        # Print user demographics summary
        if 'user_demographics' in results:
            print("\n" + "="*60)
            print("USER DEMOGRAPHICS SUMMARY")
            print("="*60)
            if 'gender_distribution' in results['user_demographics']:
                print("Gender Distribution:")
                for gender, count in results['user_demographics']['gender_distribution'].items():
                    print(f"  {gender}: {count}")
            
            if 'membership_tiers' in results['user_demographics']:
                print("\nMembership Tiers:")
                for tier, count in results['user_demographics']['membership_tiers'].items():
                    print(f"  {tier}: {count}")
            
            if 'age_analysis' in results['user_demographics']:
                age_stats = results['user_demographics']['age_analysis']
                print(f"\nAge Statistics:")
                print(f"  Mean: {age_stats['mean']:.1f}")
                print(f"  Median: {age_stats['median']:.1f}")
                print(f"  Range: {age_stats['min']:.0f} - {age_stats['max']:.0f}")
        
        # Print purchase behavior summary
        if 'purchase_behavior' in results:
            print("\n" + "="*60)
            print("PURCHASE BEHAVIOR SUMMARY")
            print("="*60)
            if 'purchase_channels' in results['purchase_behavior']:
                print("Purchase Channels:")
                for channel, count in results['purchase_behavior']['purchase_channels'].items():
                    print(f"  {channel}: {count}")
            
            if 'points_analysis' in results['purchase_behavior']:
                points = results['purchase_behavior']['points_analysis']
                print(f"\nPoints Analysis:")
                print(f"  Avg Available Points: {points['available_points_mean']:.0f}")
                print(f"  Avg Total Points: {points['total_points_mean']:.0f}")
                print(f"  Max Available Points: {points['max_available_points']:.0f}")
        
        # Print engagement summary
        if 'engagement_metrics' in results:
            print("\n" + "="*60)
            print("ENGAGEMENT SUMMARY")
            print("="*60)
            if 'activity_status' in results['engagement_metrics']:
                print("Activity Status (Last 6 months):")
                for status, count in results['engagement_metrics']['activity_status'].items():
                    print(f"  {status}: {count}")
            
            if 'registration_timeline' in results['engagement_metrics']:
                timeline = results['engagement_metrics']['registration_timeline']
                print(f"\nRegistration Timeline:")
                print(f"  Earliest: {timeline['earliest']}")
                print(f"  Latest: {timeline['latest']}")
                if timeline['total_days_span']:
                    print(f"  Span: {timeline['total_days_span']} days")
        
        # Print geographic distribution
        if 'geographic_distribution' in results:
            print("\n" + "="*60)
            print("GEOGRAPHIC DISTRIBUTION (Top 5)")
            print("="*60)
            provinces = results['geographic_distribution']['province_distribution']
            for i, (province, count) in enumerate(list(provinces.items())[:5], 1):
                print(f"  {i}. {province}: {count}")
        
    except Exception as e:
        print(f"Error during analysis: {e}")
        sys.exit(1)

if __name__ == "__main__":
    main()