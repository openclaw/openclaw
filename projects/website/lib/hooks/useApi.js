import { useState } from 'react';
import liff from '@line/liff';

/**
 * API 統一管理 Hook
 *
 * 功能：
 * - 自動攜帶 LINE Access Token
 * - 統一錯誤處理
 * - Loading 狀態管理
 * - 開發模式支援 (返回模擬資料)
 *
 * 參考: pt-liff-app/src/hooks/useApi.js
 */
export default function useApi() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const callApi = async (url, options = {}) => {
    setLoading(true);
    setError(null);

    try {
      // 開發模式：返回模擬資料
      if (process.env.NEXT_PUBLIC_DEV_MODE === 'true') {
        console.log(`[DEV] API Call: ${url}`, options);
        await new Promise(resolve => setTimeout(resolve, 500)); // 模擬網路延遲
        return { success: true, message: 'Development mode' };
      }

      // 生產模式：實際 API 請求
      const accessToken = liff.getAccessToken();

      if (!accessToken) {
        throw new Error('未取得 LINE Access Token，請重新登入');
      }

      const response = await fetch(url, {
        ...options,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`,
          ...options.headers,
        },
      });

      const data = await response.json();

      if (!response.ok) {
        // 保留完整錯誤資訊用於 debug
        const error = new Error(data.message || data.error || 'API request failed');
        error.stack = data.stack || error.stack;
        error.originalError = data;
        throw error;
      }

      return data;
    } catch (err) {
      setError(err.message);
      throw err;
    } finally {
      setLoading(false);
    }
  };

  return { callApi, loading, error };
}
