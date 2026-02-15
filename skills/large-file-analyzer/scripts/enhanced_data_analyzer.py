import pandas as pd
import numpy as np
from typing import Dict, List, Any, Optional
import logging
from datetime import datetime

class EnhancedDataAnalyzer:
    def __init__(self, max_chunk_size: int = 1000):
        self.max_chunk_size = max_chunk_size
        self.logger = logging.getLogger(__name__)
    
    def analyze_marketing_data(self, df: pd.DataFrame) -> Dict[str, Any]:
        """专门针对营销/会员数据的分析"""
        analysis = {
            "user_demographics": self._analyze_demographics(df),
            "purchase_behavior": self._analyze_purchase_behavior(df),
            "engagement_metrics": self._analyze_engagement(df),
            "geographic_distribution": self._analyze_geography(df),
            "data_quality": self._assess_data_quality(df),
            "business_insights": self._generate_business_insights(df)
        }
        return analysis
    
    def _analyze_demographics(self, df: pd.DataFrame) -> Dict[str, Any]:
        """分析用户人口统计信息"""
        demographics = {}
        
        # 性别分析
        gender_cols = [col for col in df.columns if '性别' in col or 'gender' in col.lower()]
        if gender_cols:
            gender_col = gender_cols[0]
            demographics['gender_distribution'] = df[gender_col].value_counts().to_dict()
        
        # 年龄分析
        age_cols = [col for col in df.columns if '年龄' in col or 'age' in col.lower()]
        if age_cols:
            age_col = age_cols[0]
            age_series = pd.to_numeric(df[age_col], errors='coerce')
            demographics['age_analysis'] = {
                'mean': float(age_series.mean()),
                'median': float(age_series.median()),
                'std': float(age_series.std()),
                'min': float(age_series.min()),
                'max': float(age_series.max()),
                'outliers_count': len(self._detect_outliers(age_series))
            }
        
        # 会员等级分析
        tier_cols = [col for col in df.columns if '等级' in col or 'tier' in col.lower() or 'level' in col.lower()]
        if tier_cols:
            tier_col = tier_cols[0]
            demographics['membership_tiers'] = df[tier_col].value_counts().to_dict()
        
        return demographics
    
    def _analyze_purchase_behavior(self, df: pd.DataFrame) -> Dict[str, Any]:
        """分析购买行为"""
        behavior = {}
        
        # 购买渠道分析
        channel_cols = [col for col in df.columns if '渠道' in col or 'channel' in col.lower()]
        if channel_cols:
            channel_col = channel_cols[0]
            behavior['purchase_channels'] = df[channel_col].value_counts().to_dict()
        
        # 积分分析
        points_cols = [col for col in df.columns if '积分' in col or 'points' in col.lower()]
        if len(points_cols) >= 2:
            available_points = df[points_cols[0]]
            total_points = df[points_cols[1]]
            behavior['points_analysis'] = {
                'available_points_mean': float(pd.to_numeric(available_points, errors='coerce').mean()),
                'total_points_mean': float(pd.to_numeric(total_points, errors='coerce').mean()),
                'max_available_points': float(pd.to_numeric(available_points, errors='coerce').max()),
                'max_total_points': float(pd.to_numeric(total_points, errors='coerce').max()),
                'zero_points_users': int((pd.to_numeric(available_points, errors='coerce') == 0).sum())
            }
        
        return behavior
    
    def _analyze_engagement(self, df: pd.DataFrame) -> Dict[str, Any]:
        """分析用户参与度"""
        engagement = {}
        
        # 活跃度分析
        activity_cols = [col for col in df.columns if '活跃' in col or 'activity' in col.lower() or '积分产生' in col]
        if activity_cols:
            activity_col = activity_cols[0]
            engagement['activity_status'] = df[activity_col].value_counts().to_dict()
        
        # 注册时间分析
        registration_cols = [col for col in df.columns if '注册' in col and ('时间' in col or 'date' in col.lower())]
        if registration_cols:
            reg_col = registration_cols[0]
            try:
                reg_dates = pd.to_datetime(df[reg_col], errors='coerce')
                engagement['registration_timeline'] = {
                    'earliest': reg_dates.min().isoformat() if pd.notna(reg_dates.min()) else None,
                    'latest': reg_dates.max().isoformat() if pd.notna(reg_dates.max()) else None,
                    'total_days_span': (reg_dates.max() - reg_dates.min()).days if pd.notna(reg_dates.min()) and pd.notna(reg_dates.max()) else None
                }
            except Exception as e:
                self.logger.warning(f"Could not parse registration dates: {e}")
        
        return engagement
    
    def _analyze_geography(self, df: pd.DataFrame) -> Dict[str, Any]:
        """分析地理分布"""
        geography = {}
        
        # 省市分析
        location_cols = [col for col in df.columns if '省' in col or '市' in col or 'location' in col.lower() or 'region' in col.lower()]
        if location_cols:
            loc_col = location_cols[0]
            # 提取省份（假设格式为"省份城市..."）
            provinces = df[loc_col].astype(str).str.split('省', expand=True)[0]
            geography['province_distribution'] = provinces.value_counts().head(10).to_dict()
        
        return geography
    
    def _assess_data_quality(self, df: pd.DataFrame) -> Dict[str, Any]:
        """评估数据质量"""
        quality = {
            'missing_values': {},
            'data_types': {},
            'potential_issues': []
        }
        
        # 缺失值分析
        for col in df.columns:
            missing_count = df[col].isnull().sum()
            missing_percentage = (missing_count / len(df)) * 100
            quality['missing_values'][col] = {
                'count': int(missing_count),
                'percentage': float(missing_percentage)
            }
            
            # 标记高缺失率字段
            if missing_percentage > 70:
                quality['potential_issues'].append(f"High missing rate in '{col}': {missing_percentage:.1f}%")
        
        # 数据类型分析
        for col in df.columns:
            quality['data_types'][col] = str(df[col].dtype)
        
        # 异常值检测
        numeric_cols = df.select_dtypes(include=[np.number]).columns
        for col in numeric_cols:
            series = df[col].dropna()
            if len(series) > 0:
                outliers = self._detect_outliers(series)
                if outliers:
                    quality['potential_issues'].append(f"Outliers detected in '{col}': {len(outliers)} values")
        
        return quality
    
    def _detect_outliers(self, series: pd.Series) -> List[float]:
        """检测异常值（使用IQR方法）"""
        if len(series) < 4:
            return []
        
        Q1 = series.quantile(0.25)
        Q3 = series.quantile(0.75)
        IQR = Q3 - Q1
        lower_bound = Q1 - 1.5 * IQR
        upper_bound = Q3 + 1.5 * IQR
        
        outliers = series[(series < lower_bound) | (series > upper_bound)].tolist()
        return outliers[:10]  # Limit to first 10 outliers
    
    def _generate_business_insights(self, df: pd.DataFrame) -> List[str]:
        """生成业务洞察"""
        insights = []
        
        # 活跃度洞察
        activity_cols = [col for col in df.columns if '积分产生' in col]
        if activity_cols:
            activity_col = activity_cols[0]
            inactive_ratio = (df[activity_col] == '是').mean() if '是' in df[activity_col].values else 0
            if inactive_ratio > 0.8:
                insights.append(f"🚨 高不活跃率: {inactive_ratio:.1%} 的会员在过去6个月内没有产生积分")
        
        # 渠道洞察
        channel_cols = [col for col in df.columns if '渠道' in col]
        if channel_cols:
            channel_col = channel_cols[0]
            top_channel = df[channel_col].value_counts().index[0]
            insights.append(f"🏪 主要购买渠道: {top_channel}")
        
        # 地域洞察
        location_cols = [col for col in df.columns if '省' in col or '市' in col]
        if location_cols:
            loc_col = location_cols[0]
            provinces = df[loc_col].astype(str).str.split('省', expand=True)[0]
            top_province = provinces.value_counts().index[0]
            insights.append(f"📍 主要市场区域: {top_province}")
        
        # 会员等级洞察
        tier_cols = [col for col in df.columns if '等级' in col]
        if tier_cols:
            tier_col = tier_cols[0]
            top_tier = df[tier_col].value_counts().index[0]
            top_tier_ratio = df[tier_col].value_counts().iloc[0] / len(df)
            if top_tier_ratio > 0.8:
                insights.append(f"🏆 会员结构集中: {top_tier} 等级占 {top_tier_ratio:.1%}")
        
        # 数据质量洞察
        high_missing_fields = sum(1 for col in df.columns if df[col].isnull().sum() / len(df) > 0.7)
        if high_missing_fields > 5:
            insights.append(f"⚠️ 数据质量问题: {high_missing_fields} 个字段缺失率超过70%")
        
        return insights