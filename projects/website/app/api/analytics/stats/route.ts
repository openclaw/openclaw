import { NextResponse } from 'next/server';
import { BetaAnalyticsDataClient } from '@google-analytics/data';

// 初始化 GA4 客戶端
function getAnalyticsClient() {
  // 從環境變數讀取 base64 編碼的服務帳號金鑰
  const credentials = process.env.GA4_CREDENTIALS_BASE64;

  if (!credentials) {
    throw new Error('Missing GA4_CREDENTIALS_BASE64 environment variable');
  }

  // 解碼 base64
  const credentialsJSON = Buffer.from(credentials, 'base64').toString('utf-8');
  const credentialsObj = JSON.parse(credentialsJSON);

  return new BetaAnalyticsDataClient({
    credentials: credentialsObj,
  });
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const period = searchParams.get('period') || '7'; // 預設 7 天

    const propertyId = process.env.GA4_PROPERTY_ID || '495183113';
    const analyticsDataClient = getAnalyticsClient();

    // 計算日期範圍
    const today = new Date();
    const startDate = new Date(today);
    startDate.setDate(today.getDate() - parseInt(period));

    // 查詢基本指標
    const [response] = await analyticsDataClient.runReport({
      property: `properties/${propertyId}`,
      dateRanges: [
        {
          startDate: startDate.toISOString().split('T')[0],
          endDate: today.toISOString().split('T')[0],
        },
      ],
      dimensions: [
        { name: 'date' },
      ],
      metrics: [
        { name: 'activeUsers' },
        { name: 'sessions' },
        { name: 'screenPageViews' },
        { name: 'conversions' },
      ],
    });

    // 轉換數據格式
    const dailyStats = response.rows?.map(row => ({
      date: row.dimensionValues?.[0].value || '',
      activeUsers: parseInt(row.metricValues?.[0].value || '0'),
      sessions: parseInt(row.metricValues?.[1].value || '0'),
      pageViews: parseInt(row.metricValues?.[2].value || '0'),
      conversions: parseInt(row.metricValues?.[3].value || '0'),
    })) || [];

    // 計算總計
    const totals = dailyStats.reduce((acc, day) => ({
      totalUsers: acc.totalUsers + day.activeUsers,
      totalSessions: acc.totalSessions + day.sessions,
      totalPageViews: acc.totalPageViews + day.pageViews,
      totalConversions: acc.totalConversions + day.conversions,
    }), {
      totalUsers: 0,
      totalSessions: 0,
      totalPageViews: 0,
      totalConversions: 0,
    });

    return NextResponse.json({
      success: true,
      period: parseInt(period),
      totals,
      dailyStats,
    });

  } catch (error: any) {
    console.error('GA4 API Error:', error);
    return NextResponse.json(
      {
        success: false,
        error: error.message || 'Failed to fetch analytics data',
        details: error.toString(),
      },
      { status: 500 }
    );
  }
}
