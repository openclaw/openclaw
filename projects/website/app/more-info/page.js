import Page from '@/components/core/Page.js';
import Cover from '@/components/core/Cover.js';
import Title from '@/components/core/Title.js';
import FormCard from '@/components/core/FormCard.js';

export default function MoreInfoPage() {
  return (
    <Page>
      <Cover>
        <Title>更多資訊</Title>
      </Cover>
      <div className="max-w-3xl mx-auto space-y-5">
        <FormCard
          id="company"
          title="公司資訊"
          compact
          singleColumn
          className="scroll-mt-24"
        >
          <p>
            登記名稱：思考者咖啡有限公司<br />
            統一編號：00207322<br />
          </p>
        </FormCard>
        <FormCard
          id="copyright"
          title="版權聲明"
          compact
          singleColumn
          className="scroll-mt-24"
        >
          <p>
            本網站所有課程內容、影片、講義及素材均受著作權法保護。未經授權，嚴禁下載、錄製、轉發或公開傳播。違反者將依法追究責任。
          </p>
        </FormCard>
        <FormCard
          id="tos"
          title="學生權益"
          compact
          singleColumn
          className="scroll-mt-24"
        >
          <p>
            報名前請詳閱 <a href="/files/terms-of-service.pdf" target="_blank" rel="noopener noreferrer" className="text-orange-400">學生權益書</a>，以了解您的權利與義務。
          </p>
        </FormCard>
        <FormCard
          id="refund"
          title="退費政策"
          compact
          singleColumn
          className="scroll-mt-24"
        >
          <p>
            課程一經開始，恕不接受退費。若因不可抗力因素（如授課老師臨時狀況、系統故障等）導致課程取消，我們將另行安排補課或退還相應課程費用。
          </p>
        </FormCard>
        <FormCard
          id="privacy"
          title="隱私權政策"
          compact
          singleColumn
          className="scroll-mt-24"
        >
          <div className="space-y-3 text-sm">
            <p className="font-semibold">資料收集與使用</p>
            <p>
              我們重視您的隱私。本網站僅收集必要的個人資料，包括姓名、電子郵件、聯絡電話，用於課程報名及客戶服務。
            </p>

            <p className="font-semibold">Cookie 與追蹤技術</p>
            <p>
              本網站使用 Google Analytics 分析工具以改善服務品質。這些工具可能使用 Cookie 收集匿名的使用數據，包括頁面瀏覽量、停留時間、訪客來源等。您可透過瀏覽器設定停用 Cookie。
            </p>

            <p className="font-semibold">資料保護</p>
            <p>
              我們採用適當的技術與組織措施保護您的個人資料，包括加密傳輸 (HTTPS)、安全的資料庫存取控制等。
            </p>

            <p className="font-semibold">資料分享</p>
            <p>
              未經您的同意，我們不會將您的個人資料分享給第三方，法律要求的情況除外。
            </p>

            <p className="font-semibold">您的權利</p>
            <p>
              您有權查詢、更正或刪除您的個人資料。如有需求，請聯絡客服：<a href="mailto:cruz@thinker.cafe" className="text-orange-400">cruz@thinker.cafe</a>
            </p>

            <p className="text-xs text-gray-400 mt-4">
              最後更新：2025 年 11 月
            </p>
          </div>
        </FormCard>
        <FormCard
          id="contact"
          title="聯絡客服"
          compact
          singleColumn
          className="scroll-mt-24"
        >
          <p>
            E-mail：<a href="mailto:cruz@thinker.cafe" className="text-orange-400">cruz@thinker.cafe</a><br />
            手機：0937-431-998<br />
          </p>
        </FormCard>
      </div>
    </Page>
  );
}
