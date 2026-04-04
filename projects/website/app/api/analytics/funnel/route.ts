import { NextResponse } from 'next/server';
import { BetaAnalyticsDataClient } from '@google-analytics/data';

function getAnalyticsClient() {
  const credentials = process.env.GA4_CREDENTIALS_BASE64;
  if (!credentials) {
    throw new Error('Missing GA4_CREDENTIALS_BASE64 environment variable');
  }
  const credentialsJSON = Buffer.from(credentials, 'base64').toString('utf-8');
  const credentialsObj = JSON.parse(credentialsJSON);
  return new BetaAnalyticsDataClient({ credentials: credentialsObj });
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const period = searchParams.get('period') || '7';

    const propertyId = process.env.GA4_PROPERTY_ID || '495183113';
    const analyticsDataClient = getAnalyticsClient();

    const today = new Date();
    const startDate = new Date(today);
    startDate.setDate(today.getDate() - parseInt(period));

    // 查詢轉換漏斗事件
    const [response] = await analyticsDataClient.runReport({
      property: `properties/${propertyId}`,
      dateRanges: [
        {
          startDate: startDate.toISOString().split('T')[0],
          endDate: today.toISOString().split('T')[0],
        },
      ],
      dimensions: [
        { name: 'eventName' },
      ],
      metrics: [
        { name: 'eventCount' },
      ],
      dimensionFilter: {
        filter: {
          fieldName: 'eventName',
          inListFilter: {
            values: [
              'click_explore_courses',
              'view_item',
              'add_to_cart',
              'begin_checkout',
              'purchase',
            ],
          },
        },
      },
    });

    // 轉換數據格式
    const eventCounts: Record<string, number> = {};
    response.rows?.forEach(row => {
      const eventName = row.dimensionValues?.[0].value || '';
      const count = parseInt(row.metricValues?.[0].value || '0');
      eventCounts[eventName] = count;
    });

    // 計算轉換率
    const funnelData = {
      step1_explore: eventCounts['click_explore_courses'] || 0,
      step2_view: eventCounts['view_item'] || 0,
      step3_addToCart: eventCounts['add_to_cart'] || 0,
      step4_checkout: eventCounts['begin_checkout'] || 0,
      step5_purchase: eventCounts['purchase'] || 0,
    };

    const conversionRates = {
      exploreToView: funnelData.step1_explore > 0
        ? ((funnelData.step2_view / funnelData.step1_explore) * 100).toFixed(2)
        : '0.00',
      viewToCart: funnelData.step2_view > 0
        ? ((funnelData.step3_addToCart / funnelData.step2_view) * 100).toFixed(2)
        : '0.00',
      cartToCheckout: funnelData.step3_addToCart > 0
        ? ((funnelData.step4_checkout / funnelData.step3_addToCart) * 100).toFixed(2)
        : '0.00',
      checkoutToPurchase: funnelData.step4_checkout > 0
        ? ((funnelData.step5_purchase / funnelData.step4_checkout) * 100).toFixed(2)
        : '0.00',
      overallConversion: funnelData.step1_explore > 0
        ? ((funnelData.step5_purchase / funnelData.step1_explore) * 100).toFixed(2)
        : '0.00',
    };

    return NextResponse.json({
      success: true,
      period: parseInt(period),
      funnel: funnelData,
      conversionRates,
    });

  } catch (error: any) {
    console.error('GA4 Funnel API Error:', error);
    return NextResponse.json(
      {
        success: false,
        error: error.message || 'Failed to fetch funnel data',
      },
      { status: 500 }
    );
  }
}
