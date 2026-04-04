'use client';

import { useEffect } from 'react';
import { metaEvent } from '@/lib/meta-events';

interface MetaTrackingProps {
  courseId: number;
  courseName: string;
  courseCategory?: string;
}

/**
 * Meta Pixel ViewContent 追蹤組件
 * 在課程詳情頁載入時追蹤 ViewContent 事件
 */
export default function MetaTracking({ courseId, courseName, courseCategory }: MetaTrackingProps) {
  useEffect(() => {
    // 追蹤查看課程內容
    metaEvent.viewContent(
      courseName,
      courseCategory || 'AI 課程',
      [courseId.toString()]
    );
  }, [courseId, courseName, courseCategory]);

  return null;
}
