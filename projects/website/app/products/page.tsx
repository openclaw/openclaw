import Page from '@/components/core/Page.js';
import Cover from '@/components/core/Cover.js';
import Title from '@/components/core/Title.js';
import Subtitle from '@/components/core/Subtitle.js';
import { ProductGrid } from './ProductGrid.tsx';
import parseMetadataTitle from '@/utils/parseMetadataTitle.js';

export const metadata = {
  title: parseMetadataTitle('課程一覽'),
  description: '探索 Thinker Cafe 提供的所有 AI 實戰課程，包括 ChatGPT、Midjourney 等工具的實戰教學，適合行銷人員、產品經理、創業者。',
  alternates: {
    canonical: 'https://www.thinker.cafe/products',
  },
  openGraph: {
    title: '課程一覽 | Thinker Cafe',
    description: '探索 Thinker Cafe 提供的所有 AI 實戰課程',
    url: 'https://www.thinker.cafe/products',
    siteName: 'Thinker Cafe',
    locale: 'zh_TW',
    type: 'website',
  },
};

export default function ProductsPage() {
  // CollectionPage Schema for SEO
  const collectionPageSchema = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    "name": "AI 實戰課程一覽",
    "description": "探索 Thinker Cafe 提供的所有 AI 實戰課程",
    "url": "https://www.thinker.cafe/products",
    "provider": {
      "@type": "Organization",
      "name": "Thinker Cafe",
      "url": "https://www.thinker.cafe"
    },
    "about": {
      "@type": "Thing",
      "name": "AI 課程",
      "description": "AI 工具實戰教學課程"
    }
  };

  return (
    <Page>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(collectionPageSchema) }}
      />
      <Cover>
        <Title>我們的課程</Title>
        <Subtitle>未來的創作者，都懂 AI。</Subtitle>
      </Cover>
      <ProductGrid />
    </Page>
  );
}
