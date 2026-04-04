'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { TriangleAlert, LoaderCircle } from 'lucide-react';
import FormCard from '@/components/core/FormCard.js';
import FormFooter from '@/components/core/FormFooter.js';
import FormButton from '@/components/core/FormButton.js';
import { createClient } from '@/utils/supabase/client.ts';
import { parseStudentIdString } from '@/utils/profile.js';
import { parseOrderIdString } from '@/utils/order.js';

export default function PayedOrMessagedOrderForm({ order, profile }) {
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const router = useRouter();

  async function updateOrderState() {
    setErrorMessage('');
    setLoading(true);

    const supabase = createClient();
    const { error } = await supabase
      .from('orders')
      .update({ state: 'messaged' })
      .eq('order_id', order.order_id);

    if (error) {
      const { code, message } = error;
      setErrorMessage(`[${code}] ${message}`);
      setLoading(false);
      return;
    }

    router.refresh();
  }

  return (
    <div className="max-w-3xl mx-auto space-y-5">
      <FormCard singleColumn title="步驟 4. 驗證繳費">
        <div className="space-y-4">
          <p>
            LINE 搜尋 <span className="font-bold text-orange-400">@836tattx</span> 或掃描下方 <span className="font-bold text-orange-400">QR code</span>，將思考者咖啡 LINE 官方帳號加為好友。
          </p>
          <p className="flex justify-center">
            <img
              src="/files/qr-code.png"
              alt="QR code"
              width={160}
              height={160}
              className="rounded-lg"
            />
          </p>
          <p>
            加為好友後，於聊天室傳送下列資訊：
          </p>
          <ol className="list-decimal list-inside font-bold text-orange-400">
            <li>
              學員編號：<span className="font-mono">{parseStudentIdString(profile)}</span>
            </li>
            <li>
              報名序號：{parseOrderIdString(order)}
            </li>
            <li>
              轉帳銀行名稱：（例如：中華郵政）
            </li>
            <li>
              轉帳帳號末五碼：（例如：<span className="font-mono">12345</span>）
            </li>
          </ol>
          <p>
            待專員為您驗證繳費後，方可開始安排課程。
          </p>
        </div>
      </FormCard>
      <FormCard singleColumn>
        <ul className="ml-4 list-disc font-bold text-red-600">
          <li>請務必於 24 小時內完成驗證。若超過 24 小時，此報名將自動取消。</li>
          <li>在完成驗證前，請將此分頁維持開啟或存成書籤，以免遺失驗證資訊。</li>
        </ul>
      </FormCard>
      {errorMessage && (
        <FormCard error singleColumn>
          <p className="flex items-center gap-2">
            <TriangleAlert size={18} />
            {errorMessage}
          </p>
        </FormCard>
      )}
      <FormFooter>
        {order.state === 'payed' && (
          <FormButton
            primary
            type="button"
            onClick={() => updateOrderState()}
            disabled={loading}
          >
            {loading && <LoaderCircle size={20} className="mr-1 animate-spin" />}
            已傳送訊息，開始驗證
          </FormButton>
        )}
        {order.state === 'messaged' && (
          <FormButton
            primary
            type="button"
            disabled
          >
            專員將盡速透過 LINE 與您聯繫
          </FormButton>
        )}
      </FormFooter>
    </div>
  );
}
