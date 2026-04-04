import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/utils/supabase/server';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const courseIdParam = searchParams.get('course_id');

    if (!courseIdParam) {
      return NextResponse.json(
        { error: 'Missing course_id parameter' },
        { status: 400 }
      );
    }

    const supabase = await createClient();

    // 處理兩種 ID 格式：
    // 1. 數字 ID (如: 6) -> 直接使用
    // 2. UUID (如: 28805e9d-e121-807a-a596-f976e32ae474) -> 需要從 courses 表查詢對應的數字 ID
    let courseId: number;

    if (/^\d+$/.test(courseIdParam)) {
      // 如果是純數字，直接使用
      courseId = parseInt(courseIdParam, 10);
    } else {
      // 如果是 UUID，從 courses 表查詢對應的數字 ID
      // 注意：目前 courses 表沒有存 notion_page_id，所以我們假設 URL 中的 UUID 對應到課程 6
      // TODO: 未來需要在 courses 表加入 notion_page_id 欄位

      // 暫時硬編碼：如果是這個 UUID，就是課程 6
      if (courseIdParam === '28805e9d-e121-807a-a596-f976e32ae474') {
        courseId = 6;
      } else {
        return NextResponse.json(
          { error: 'Invalid course_id format' },
          { status: 400 }
        );
      }
    }

    // 查詢已付款的訂單數量
    // 注意：資料表欄位名稱是 'state'，已付款狀態是 'payed'
    const { count, error } = await supabase
      .from('orders')
      .select('*', { count: 'exact', head: true })
      .eq('course_id', courseId)
      .eq('state', 'payed');

    if (error) {
      console.error('Error fetching enrollment count:', error);
      // 即使出錯也返回 0，不影響前端顯示
      return NextResponse.json({ count: 0 });
    }

    return NextResponse.json({ count: count || 0 });
  } catch (error) {
    console.error('Unexpected error in enrollment-count API:', error);
    // 返回 0 而不是錯誤，確保前端不會因為 API 失敗而中斷
    return NextResponse.json({ count: 0 });
  }
}
