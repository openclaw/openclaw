import { NextResponse } from 'next/server';
import { createClient } from '@/utils/supabase/server';
import {
  sendPaymentReminder,
  sendOrderConfirmation,
  sendPaymentSuccess,
  sendCourseStartReminder,
} from '@/lib/line/notify';

/**
 * LINE 通知 API
 *
 * 內部 API，用於發送 LINE 通知給用戶
 * 需要驗證請求來源（例如：API Key 或 Supabase Auth）
 */

export async function POST(request) {
  try {
    const { type, orderId, userId } = await request.json();

    // 驗證必要參數
    if (!type) {
      return NextResponse.json(
        { success: false, message: 'Missing type parameter' },
        { status: 400 }
      );
    }

    // 根據通知類型處理
    switch (type) {
      case 'payment_reminder':
        return await handlePaymentReminder(orderId);

      case 'order_confirmation':
        return await handleOrderConfirmation(orderId);

      case 'payment_success':
        return await handlePaymentSuccess(orderId);

      case 'course_start':
        return await handleCourseStart(orderId);

      default:
        return NextResponse.json(
          { success: false, message: 'Unknown notification type' },
          { status: 400 }
        );
    }
  } catch (error) {
    console.error('❌ LINE Notify API error:', error);
    return NextResponse.json(
      {
        success: false,
        message: 'Internal server error',
        error: error.message,
      },
      { status: 500 }
    );
  }
}

/**
 * 處理繳費提醒通知
 */
async function handlePaymentReminder(orderId) {
  const supabase = await createClient();

  // 1. 查詢訂單
  const { data: order, error: orderError } = await supabase
    .from('orders')
    .select('*')
    .eq('order_id', orderId)
    .single();

  if (orderError || !order) {
    console.error('Order not found:', orderError);
    return NextResponse.json(
      { success: false, message: 'Order not found' },
      { status: 404 }
    );
  }

  // 2. 查詢用戶 profile（取得 LINE User ID）
  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('line_user_id, full_name')
    .eq('user_id', order.user_id)
    .single();

  if (profileError || !profile || !profile.line_user_id) {
    console.error('LINE User ID not found:', profileError);
    return NextResponse.json(
      { success: false, message: 'LINE User ID not found' },
      { status: 404 }
    );
  }

  // 3. 查詢課程資料
  const { getProducts } = await import('@/lib/notion');
  const courses = await getProducts();
  const course = courses.find((c) => c.course_id === order.course_id);

  if (!course) {
    console.error('Course not found');
    return NextResponse.json(
      { success: false, message: 'Course not found' },
      { status: 404 }
    );
  }

  // 4. 格式化課程名稱
  const { parseCourseName } = await import('@/utils/course');
  const formattedCourseName = parseCourseName(course);

  // 5. 計算繳費期限
  const createdAt = new Date(order.created_at);
  const expiresAt = createdAt.getTime() + 24 * 60 * 60 * 1000;

  // 6. 發送 LINE 通知
  await sendPaymentReminder(profile.line_user_id, {
    studentName: profile.full_name || '學員',
    orderID: String(orderId),
    courseName: formattedCourseName,
    amount: order.total,
    expiresAt: expiresAt,
    paymentURL: `${process.env.SITE_URL || process.env.NEXT_PUBLIC_SITE_URL || 'https://thinker.cafe'}/order/${orderId}`,
  });

  return NextResponse.json({
    success: true,
    message: 'Payment reminder sent',
    lineUserId: profile.line_user_id,
  });
}

/**
 * 處理訂單確認通知
 */
async function handleOrderConfirmation(orderId) {
  const supabase = await createClient();

  // 1. 查詢訂單
  const { data: order, error: orderError } = await supabase
    .from('orders')
    .select('*')
    .eq('order_id', orderId)
    .single();

  if (orderError || !order) {
    return NextResponse.json(
      { success: false, message: 'Order not found' },
      { status: 404 }
    );
  }

  // 2. 查詢用戶 profile
  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('line_user_id, full_name')
    .eq('user_id', order.user_id)
    .single();

  if (profileError || !profile || !profile.line_user_id) {
    return NextResponse.json(
      { success: false, message: 'LINE User ID not found' },
      { status: 404 }
    );
  }

  // 3. 查詢課程資料
  const { getProducts } = await import('@/lib/notion');
  const courses = await getProducts();
  const course = courses.find((c) => c.course_id === order.course_id);

  if (!course) {
    return NextResponse.json(
      { success: false, message: 'Course not found' },
      { status: 404 }
    );
  }

  const { parseCourseName } = await import('@/utils/course');
  const formattedCourseName = parseCourseName(course);

  // 4. 發送 LINE 通知
  await sendOrderConfirmation(profile.line_user_id, {
    studentName: profile.full_name || '學員',
    orderID: String(orderId),
    courseName: formattedCourseName,
    amount: order.total,
    paymentURL: `${process.env.SITE_URL || process.env.NEXT_PUBLIC_SITE_URL || 'https://thinker.cafe'}/order/${orderId}`,
  });

  return NextResponse.json({
    success: true,
    message: 'Order confirmation sent',
  });
}

/**
 * 處理繳費成功通知
 */
async function handlePaymentSuccess(orderId) {
  const supabase = await createClient();

  const { data: order } = await supabase
    .from('orders')
    .select('*')
    .eq('order_id', orderId)
    .single();

  if (!order) {
    return NextResponse.json(
      { success: false, message: 'Order not found' },
      { status: 404 }
    );
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('line_user_id, full_name')
    .eq('user_id', order.user_id)
    .single();

  if (!profile || !profile.line_user_id) {
    return NextResponse.json(
      { success: false, message: 'LINE User ID not found' },
      { status: 404 }
    );
  }

  const { getProducts } = await import('@/lib/notion');
  const courses = await getProducts();
  const course = courses.find((c) => c.course_id === order.course_id);

  const { parseCourseName } = await import('@/utils/course');
  const formattedCourseName = parseCourseName(course);

  await sendPaymentSuccess(profile.line_user_id, {
    studentName: profile.full_name || '學員',
    orderID: String(orderId),
    courseName: formattedCourseName,
    amount: order.total,
  });

  return NextResponse.json({
    success: true,
    message: 'Payment success notification sent',
  });
}

/**
 * 處理課程開課提醒
 */
async function handleCourseStart(orderId) {
  // TODO: 實作課程開課提醒
  return NextResponse.json({
    success: false,
    message: 'Not implemented yet',
  });
}
