/**
 * Meta Pixel 事件追蹤函數
 * 用於前端觸發 Meta Pixel 事件
 */

declare global {
  interface Window {
    fbq: any;
  }
}

export const metaEvent = {
  /**
   * 追蹤頁面瀏覽（自動追蹤，無需手動呼叫）
   */
  pageView: () => {
    if (typeof window !== 'undefined' && window.fbq) {
      window.fbq('track', 'PageView');
    }
  },

  /**
   * 追蹤查看內容
   * @param contentName 內容名稱
   * @param contentCategory 內容類別
   * @param contentIds 內容 ID 陣列
   */
  viewContent: (contentName: string, contentCategory?: string, contentIds?: string[]) => {
    if (typeof window !== 'undefined' && window.fbq) {
      window.fbq('track', 'ViewContent', {
        content_name: contentName,
        content_category: contentCategory,
        content_ids: contentIds,
      });
    }
  },

  /**
   * 追蹤開始結帳
   * @param value 訂單金額
   * @param currency 貨幣代碼
   * @param contents 商品內容
   */
  initiateCheckout: (value: number, currency: string = 'TWD', contents?: any[]) => {
    if (typeof window !== 'undefined' && window.fbq) {
      window.fbq('track', 'InitiateCheckout', {
        value,
        currency,
        contents,
        num_items: contents?.length || 1,
      });
    }
  },

  /**
   * 追蹤購買完成
   * @param value 訂單金額
   * @param currency 貨幣代碼
   * @param contents 商品內容
   */
  purchase: (value: number, currency: string = 'TWD', contents?: any[]) => {
    if (typeof window !== 'undefined' && window.fbq) {
      window.fbq('track', 'Purchase', {
        value,
        currency,
        contents,
        num_items: contents?.length || 1,
      });
    }
  },

  /**
   * 追蹤潛在客戶（表單提交）
   * @param value 預估價值
   * @param currency 貨幣代碼
   */
  lead: (value?: number, currency: string = 'TWD') => {
    if (typeof window !== 'undefined' && window.fbq) {
      window.fbq('track', 'Lead', {
        value,
        currency,
      });
    }
  },

  /**
   * 追蹤加入購物車
   * @param value 商品金額
   * @param currency 貨幣代碼
   * @param contentName 商品名稱
   * @param contentId 商品 ID
   */
  addToCart: (value: number, currency: string = 'TWD', contentName?: string, contentId?: string) => {
    if (typeof window !== 'undefined' && window.fbq) {
      window.fbq('track', 'AddToCart', {
        value,
        currency,
        content_name: contentName,
        content_ids: contentId ? [contentId] : undefined,
      });
    }
  },

  /**
   * 追蹤搜尋
   * @param searchString 搜尋字串
   */
  search: (searchString: string) => {
    if (typeof window !== 'undefined' && window.fbq) {
      window.fbq('track', 'Search', {
        search_string: searchString,
      });
    }
  },

  /**
   * 自訂事件
   * @param eventName 事件名稱
   * @param parameters 事件參數
   */
  custom: (eventName: string, parameters?: Record<string, any>) => {
    if (typeof window !== 'undefined' && window.fbq) {
      window.fbq('trackCustom', eventName, parameters);
    }
  },
};
