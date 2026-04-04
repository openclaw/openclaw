'use client';

import { useRouter } from 'next/navigation';
import FormButton from '@/components/core/FormButton.js';
import { trackAddToCart } from '@/lib/analytics';
import { useMetaTracking } from '@/hooks/useMetaTracking';

export default function BuyCourseButton({ courseId, courseName, courseCategory, coursePrice, className, children }) {
  const router = useRouter();
  const { trackInitiateCheckout } = useMetaTracking();

  // 目前只有第六課開放報名
  const isAvailable = courseId === 6;

  const handleClick = async () => {
    if (isAvailable) {
      // GA4 追蹤
      trackAddToCart({
        id: courseId.toString(),
        name: courseName || '課程名稱',
        category: courseCategory || '分類',
        variant: 'group', // 預設團班，在表單頁會再追蹤實際選擇
        price: coursePrice || 0
      });

      // Meta Pixel 雙層追蹤 - InitiateCheckout
      await trackInitiateCheckout(
        coursePrice || 0,
        'TWD',
        [{ id: courseId.toString(), quantity: 1 }]
      );

      router.push(`/buy-course/${courseId}`);
    }
  };

  return (
    <FormButton
      primary={isAvailable}
      className={className}
      type="button"
      onClick={handleClick}
      disabled={!isAvailable}
    >
      {isAvailable ? children : '即將開放'}
    </FormButton>
  );
}
