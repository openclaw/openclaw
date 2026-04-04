'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import liff from '@line/liff';
import { createClient } from '@/utils/supabase/client.ts';

export default function LineLoginPage() {
  const router = useRouter();
  const [status, setStatus] = useState('initializing'); // initializing, logging_in, verifying, success, error
  const [error, setError] = useState(null);

  useEffect(() => {
    initializeLiff();
  }, []);

  async function initializeLiff() {
    try {
      // 開發模式：跳過 LIFF
      if (process.env.NEXT_PUBLIC_DEV_MODE === 'true') {
        console.log('🔧 開發模式：跳過 LIFF 登入');
        setStatus('success');
        setTimeout(() => {
          router.push('/products');
        }, 1000);
        return;
      }

      setStatus('initializing');

      console.log('🔧 LIFF ID:', process.env.NEXT_PUBLIC_LIFF_ID);
      console.log('🔧 當前 URL:', window.location.href);

      // 初始化 LIFF
      await liff.init({
        liffId: process.env.NEXT_PUBLIC_LIFF_ID,
        withLoginOnExternalBrowser: true,
      });

      console.log('✅ LIFF 初始化成功');

      // 檢查是否已登入
      if (!liff.isLoggedIn()) {
        setStatus('logging_in');
        liff.login();
        return;
      }

      // 取得 LINE Profile
      setStatus('verifying');
      let profile, accessToken, idToken;

      try {
        profile = await liff.getProfile();
        accessToken = liff.getAccessToken();
        idToken = liff.getIDToken();
      } catch (profileError) {
        console.error('❌ 取得 Profile 失敗:', profileError);

        // 如果是 token 撤銷錯誤，重新登入
        if (profileError.message && profileError.message.includes('revoked')) {
          console.log('🔄 Access token 已撤銷，重新登入...');
          liff.logout();
          setStatus('logging_in');
          liff.login();
          return;
        }

        throw profileError;
      }

      console.log('LINE Profile:', profile);

      // 呼叫後端 API 驗證並建立/登入用戶
      const response = await fetch('/api/line/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          lineUserId: profile.userId,
          displayName: profile.displayName,
          pictureUrl: profile.pictureUrl,
          accessToken,
          idToken,
        }),
      });

      if (!response.ok) {
        console.error('❌ API 回應狀態:', response.status, response.statusText);
        let errorMsg = '登入失敗';
        try {
          const errorData = await response.json();
          console.error('❌ API 錯誤內容:', JSON.stringify(errorData, null, 2));
          errorMsg = errorData.error || '登入失敗';
          const details = errorData.details || errorData.code || errorData.fullError || '';
          if (details) {
            errorMsg += '\n詳情: ' + details;
          }
        } catch (jsonError) {
          // 如果無法解析為 JSON，嘗試讀取原始文字（但 Response 只能讀取一次）
          console.error('❌ 無法解析 JSON 回應:', jsonError.message);
          errorMsg = `API 錯誤 (${response.status})`;
        }
        throw new Error(errorMsg);
      }

      const data = await response.json();
      console.log('登入 API 回應:', data);

      if (!data.success) {
        console.error('API 返回失敗:', data);
        const errorMsg = data.error || '登入失敗';
        const details = data.details || data.code || data.fullError || '';
        throw new Error(errorMsg + (details ? '\n詳情: ' + details : ''));
      }

      // 如果 API 返回 session，設置到 Supabase Client
      if (data.session) {
        const supabase = createClient();
        const { error: sessionError } = await supabase.auth.setSession({
          access_token: data.session.access_token,
          refresh_token: data.session.refresh_token,
        });

        if (sessionError) {
          console.error('設置 session 失敗:', sessionError);
          throw new Error('無法建立登入狀態');
        }
      }

      setStatus('success');

      // 導向到產品頁面
      setTimeout(() => {
        router.push('/products');
        router.refresh();
      }, 1000);

    } catch (err) {
      console.error('❌ LINE Login 錯誤:', err);
      console.error('❌ 錯誤訊息:', err.message);
      console.error('❌ 完整錯誤:', err);
      setStatus('error');

      // 顯示更詳細的錯誤訊息
      let errorMsg = err.message || '未知錯誤';
      if (err.response) {
        errorMsg += ` (HTTP ${err.response.status})`;
      }
      setError(errorMsg);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-green-400 to-blue-500">
      <div className="bg-white rounded-2xl shadow-2xl p-8 max-w-md w-full mx-4">
        {/* Logo */}
        <div className="text-center mb-8">
          <div className="inline-block">
            <svg className="w-20 h-20 text-green-500" fill="currentColor" viewBox="0 0 24 24">
              <path d="M19.365 9.863c.349 0 .63.285.63.631 0 .345-.281.63-.63.63H17.61v1.125h1.755c.349 0 .63.283.63.63 0 .344-.281.629-.63.629h-2.386c-.345 0-.627-.285-.627-.629V8.108c0-.345.282-.63.63-.63h2.386c.346 0 .627.285.627.63 0 .349-.281.63-.63.63H17.61v1.125h1.755zm-3.855 3.016c0 .27-.174.51-.432.596-.064.021-.133.031-.199.031-.211 0-.391-.09-.51-.25l-2.443-3.317v2.94c0 .344-.279.629-.631.629-.346 0-.626-.285-.626-.629V8.108c0-.27.173-.51.43-.595.06-.023.136-.033.194-.033.195 0 .375.104.495.254l2.462 3.33V8.108c0-.345.282-.63.63-.63.345 0 .63.285.63.63v4.771zm-5.741 0c0 .344-.282.629-.631.629-.345 0-.627-.285-.627-.629V8.108c0-.345.282-.63.63-.63.346 0 .628.285.628.63v4.771zm-2.466.629H4.917c-.345 0-.63-.285-.63-.629V8.108c0-.345.285-.63.63-.63.348 0 .63.285.63.63v4.141h1.756c.348 0 .629.283.629.63 0 .344-.282.629-.629.629M24 10.314C24 4.943 18.615.572 12 .572S0 4.943 0 10.314c0 4.811 4.27 8.842 10.035 9.608.391.082.923.258 1.058.59.12.301.079.766.038 1.08l-.164 1.02c-.045.301-.24 1.186 1.049.645 1.291-.539 6.916-4.078 9.436-6.975C23.176 14.393 24 12.458 24 10.314" />
            </svg>
          </div>
          <h1 className="text-2xl font-bold text-gray-800 mt-4">LINE 登入</h1>
        </div>

        {/* Status Display */}
        <div className="text-center">
          {status === 'initializing' && (
            <>
              <div className="animate-spin rounded-full h-16 w-16 border-b-2 border-green-500 mx-auto"></div>
              <p className="mt-4 text-gray-600">初始化中...</p>
            </>
          )}

          {status === 'logging_in' && (
            <>
              <div className="animate-spin rounded-full h-16 w-16 border-b-2 border-green-500 mx-auto"></div>
              <p className="mt-4 text-gray-600">正在導向 LINE 登入...</p>
            </>
          )}

          {status === 'verifying' && (
            <>
              <div className="animate-spin rounded-full h-16 w-16 border-b-2 border-blue-500 mx-auto"></div>
              <p className="mt-4 text-gray-600">驗證您的帳號...</p>
            </>
          )}

          {status === 'success' && (
            <>
              <div className="text-green-500 mb-4">
                <svg className="w-16 h-16 mx-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </div>
              <p className="text-xl font-semibold text-gray-800">登入成功！</p>
              <p className="mt-2 text-gray-600">正在導向...</p>
            </>
          )}

          {status === 'error' && (
            <>
              <div className="text-red-500 mb-4">
                <svg className="w-16 h-16 mx-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </div>
              <p className="text-xl font-semibold text-red-600">登入失敗</p>
              <p className="mt-2 text-gray-600">{error}</p>
              <button
                onClick={() => window.location.reload()}
                className="mt-4 px-6 py-2 bg-green-500 text-white rounded-lg hover:bg-green-600 transition-colors"
              >
                重試
              </button>
            </>
          )}
        </div>

        {/* Info */}
        <div className="mt-8 pt-6 border-t border-gray-200">
          <p className="text-xs text-gray-500 text-center">
            使用 LINE 登入即表示您同意我們的<br />
            <a href="/terms" className="text-green-500 hover:underline">服務條款</a>
            {' '}和{' '}
            <a href="/privacy" className="text-green-500 hover:underline">隱私政策</a>
          </p>
        </div>
      </div>
    </div>
  );
}
