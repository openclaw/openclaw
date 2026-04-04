import { useCallback } from 'react';
import { metaEvent } from '@/lib/meta-events';

/**
 * Meta Pixel 雙層追蹤 Hook
 * 同時觸發前端 Pixel 和後端 Conversion API
 */

interface UserData {
  email?: string;
  phone?: string;
  firstName?: string;
  lastName?: string;
  city?: string;
  state?: string;
  zip?: string;
  country?: string;
}

interface CustomData {
  value?: number;
  currency?: string;
  content_name?: string;
  content_category?: string;
  content_ids?: string[];
  contents?: any[];
  num_items?: number;
}

export function useMetaTracking() {
  const trackEvent = useCallback(
    async (
      eventName: string,
      customData?: CustomData,
      userData?: UserData
    ) => {
      // 生成唯一 eventId（用於去重）
      const eventId = `${eventName}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

      try {
        // 1. 前端 Pixel 追蹤（即時）
        if (typeof window !== 'undefined' && window.fbq) {
          window.fbq('track', eventName, customData, { eventID: eventId });
        }

        // 2. 後端 Conversion API 追蹤（強化）
        await fetch('/api/meta/conversion', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            eventName,
            eventId, // 相同的 eventId 會自動去重
            userData,
            customData,
            eventSourceUrl: window.location.href,
            actionSource: 'website',
          }),
        });

        console.log(`✅ Meta Event tracked: ${eventName}`, {
          eventId,
          customData,
        });
      } catch (error) {
        console.error('❌ Failed to track Meta event:', error);
      }
    },
    []
  );

  return {
    /**
     * 追蹤查看內容
     */
    trackViewContent: useCallback(
      (contentName: string, contentCategory?: string, contentIds?: string[]) => {
        metaEvent.viewContent(contentName, contentCategory, contentIds);
      },
      []
    ),

    /**
     * 追蹤開始結帳
     */
    trackInitiateCheckout: useCallback(
      async (value: number, currency: string = 'TWD', contents?: any[], userData?: UserData) => {
        await trackEvent(
          'InitiateCheckout',
          {
            value,
            currency,
            contents,
            num_items: contents?.length || 1,
          },
          userData
        );
      },
      [trackEvent]
    ),

    /**
     * 追蹤購買完成
     */
    trackPurchase: useCallback(
      async (
        value: number,
        currency: string = 'TWD',
        contents?: any[],
        userData?: UserData
      ) => {
        await trackEvent(
          'Purchase',
          {
            value,
            currency,
            contents,
            num_items: contents?.length || 1,
          },
          userData
        );
      },
      [trackEvent]
    ),

    /**
     * 追蹤潛在客戶
     */
    trackLead: useCallback(
      async (value?: number, currency: string = 'TWD', userData?: UserData) => {
        await trackEvent(
          'Lead',
          {
            value,
            currency,
          },
          userData
        );
      },
      [trackEvent]
    ),

    /**
     * 追蹤加入購物車
     */
    trackAddToCart: useCallback(
      (value: number, currency: string = 'TWD', contentName?: string, contentId?: string) => {
        metaEvent.addToCart(value, currency, contentName, contentId);
      },
      []
    ),

    /**
     * 自訂事件追蹤
     */
    trackCustomEvent: useCallback(
      async (eventName: string, customData?: CustomData, userData?: UserData) => {
        await trackEvent(eventName, customData, userData);
      },
      [trackEvent]
    ),
  };
}
