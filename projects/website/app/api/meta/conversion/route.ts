import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';

/**
 * Meta Conversion API
 * Server-side 事件追蹤，提供更準確的轉換追蹤
 */

// Hash 函數（用於加密用戶資料）
function hashData(data: string): string {
  return crypto.createHash('sha256').update(data.toLowerCase().trim()).digest('hex');
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      eventName,
      eventId, // 用於去重
      userData,
      customData,
      eventSourceUrl,
      actionSource = 'website',
    } = body;

    const pixelId = process.env.META_PIXEL_ID;
    const accessToken = process.env.META_CONVERSION_API_TOKEN;

    if (!pixelId || !accessToken) {
      console.error('Meta Pixel 配置缺失');
      return NextResponse.json(
        { error: 'Meta Pixel not configured' },
        { status: 500 }
      );
    }

    // 準備用戶資料（加密）
    const hashedUserData: Record<string, any> = {};

    if (userData?.email) {
      hashedUserData.em = hashData(userData.email);
    }
    if (userData?.phone) {
      hashedUserData.ph = hashData(userData.phone);
    }
    if (userData?.firstName) {
      hashedUserData.fn = hashData(userData.firstName);
    }
    if (userData?.lastName) {
      hashedUserData.ln = hashData(userData.lastName);
    }
    if (userData?.city) {
      hashedUserData.ct = hashData(userData.city);
    }
    if (userData?.state) {
      hashedUserData.st = hashData(userData.state);
    }
    if (userData?.zip) {
      hashedUserData.zp = hashData(userData.zip);
    }
    if (userData?.country) {
      hashedUserData.country = hashData(userData.country);
    }

    // 從請求中獲取額外資訊
    const clientIpAddress = request.headers.get('x-forwarded-for') ||
                           request.headers.get('x-real-ip') ||
                           'unknown';
    const clientUserAgent = request.headers.get('user-agent') || 'unknown';

    // 構建事件資料
    const eventData = {
      event_name: eventName,
      event_time: Math.floor(Date.now() / 1000),
      event_id: eventId, // 用於去重（前端和後端相同的 eventId 會自動去重）
      event_source_url: eventSourceUrl || request.headers.get('referer'),
      action_source: actionSource,
      user_data: {
        ...hashedUserData,
        client_ip_address: clientIpAddress,
        client_user_agent: clientUserAgent,
      },
      custom_data: customData || {},
    };

    // 發送到 Meta Conversion API
    const response = await fetch(
      `https://graph.facebook.com/v18.0/${pixelId}/events`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          data: [eventData],
          access_token: accessToken,
          test_event_code: 'TEST73555', // Meta 測試事件代碼
        }),
      }
    );

    const result = await response.json();

    if (!response.ok) {
      console.error('Meta Conversion API Error:', result);
      return NextResponse.json(
        { error: 'Failed to send event to Meta', details: result },
        { status: response.status }
      );
    }

    console.log('✅ Meta Conversion API Success:', {
      eventName,
      eventId,
      result,
    });

    return NextResponse.json({ success: true, result });
  } catch (error) {
    console.error('❌ Meta Conversion API Error:', error);
    return NextResponse.json(
      { error: 'Internal server error', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}
