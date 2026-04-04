import Link from "next/link";
import { notFound } from "next/navigation";
import { getProductById } from "@/lib/notion";
import { Badge } from "@/components/ui/badge";
import Page from '@/components/core/Page.js';
import Cover from '@/components/core/Cover.js';
import BuyCourseButton from './BuyCourseButton.js';
import Bar from './Bar.js';
import Content from './Content.js';
import HighlightGrid from './HighlightGrid.js';
import CourseInfo from './CourseInfo';
import FAQ from '@/components/course/FAQ';
import RoleSelector from '@/components/course/RoleSelector';
import CourseProgressTracker from '@/components/course/CourseProgressTracker';
import ScrollBottomDetector from '@/components/course/ScrollBottomDetector';
import ExplorerReward from '@/components/course/ExplorerReward';
import PreparationChecklist from '@/components/course/PreparationChecklist';
import { parseCourseName } from '@/utils/course.js';
import parseMetadataTitle from '@/utils/parseMetadataTitle.js';
import { universalFAQ, course6FAQ } from '@/data/faq';
import MetaTracking from './MetaTracking';

export const runtime = "nodejs";
export const revalidate = 60;

type Item = { title?: string; description?: string; image?: string };

export async function generateMetadata({ params }) {
  const { id } = await params;
  const product = await getProductById(id);

  if (!product) {
    return {
      title: "課程未找到 | Thinker Cafe",
    }
  }

  const title = parseCourseName(product, '');
  const description = product.zh_description || `${title} - Thinker Cafe AI 實戰課程。立即報名學習最新的 AI 工具與技術！`;
  const imageUrl = product.main_image || product.image || 'https://www.thinker.cafe/og-image.png';

  return {
    title: parseMetadataTitle(title),
    description: description,
    keywords: [
      title,
      "AI 課程",
      "AI 實戰",
      product.zh_category || "AI 工具",
      "Thinker Cafe",
      ...(product.content_tags || [])
    ],
    alternates: {
      canonical: `https://www.thinker.cafe/products/${id}`,
    },
    openGraph: {
      title: title,
      description: description,
      url: `https://www.thinker.cafe/products/${id}`,
      siteName: "Thinker Cafe",
      images: [
        {
          url: imageUrl,
          width: 1200,
          height: 630,
          alt: title
        }
      ],
      locale: "zh_TW",
      type: "website"
    },
    twitter: {
      card: "summary_large_image",
      title: title,
      description: description,
      images: [imageUrl]
    },
    robots: {
      index: true,
      follow: true,
    },
  }
}

export default async function ProductContentPage({
  params,
}: {
  params: { id: string };
}) {
  const { id } = await params;
  const product: any = await getProductById(id);
  if (!product) return notFound();

  const courseId = product.course_id;
  const title = product.zh_name;
  const subtitle = product.zh_description;
  const heroMedia = product.content_video || product.image;
  const items = FIXED_SIX(product);

  // 根據課程 ID 選擇 FAQ
  const faqItems = courseId === 6 ? course6FAQ : universalFAQ;

  // Course Schema for SEO
  const courseSchema = {
    "@context": "https://schema.org",
    "@type": "Course",
    "name": parseCourseName(product, ''),
    "description": product.zh_description || `${title} - Thinker Cafe AI 實戰課程`,
    "provider": {
      "@type": "Organization",
      "name": "Thinker Cafe",
      "sameAs": "https://www.thinker.cafe"
    },
    "image": product.main_image || product.image,
    "offers": {
      "@type": "Offer",
      "category": "教育課程",
      "price": product.single_price || product.group_price,
      "priceCurrency": "TWD",
      "availability": "https://schema.org/InStock",
      "url": `https://www.thinker.cafe/products/${id}`,
      "validFrom": new Date().toISOString()
    },
    "courseCode": product.course_id,
    "hasCourseInstance": {
      "@type": "CourseInstance",
      "courseMode": product.course_mode || "線上+實體",
      "courseWorkload": product.duration || "數週課程"
    },
    "inLanguage": "zh-TW",
    "availableLanguage": ["zh-TW"]
  };

  // FAQPage Schema for SEO
  const faqSchema = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    "mainEntity": faqItems.map(item => ({
      "@type": "Question",
      "name": item.question,
      "acceptedAnswer": {
        "@type": "Answer",
        "text": item.answer
      }
    }))
  };

  return (
    <Page>
      {/* Meta Pixel ViewContent 追蹤 */}
      <MetaTracking
        courseId={courseId}
        courseName={title}
        courseCategory={product.zh_category}
      />
      {/* Course Schema */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(courseSchema) }}
      />
      {/* FAQPage Schema */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqSchema) }}
      />
      <Cover fullScreenHeight className="flex flex-col justify-end items-start pb-8">
        <video
          className="absolute top-0 left-0 z-0 w-screen h-screen object-cover"
          src={heroMedia}
          autoPlay
          muted
          loop
          playsInline
        />
            <div className="relative z-1 space-y-3 mb-8 lg:space-y-5">
              {(product.zh_category) && (
                <Badge
                  variant="secondary"
                  className="animate-glow bg-gradient-to-r from-orange-400 to-pink-500 text-black bg-gradient-animate"
                >
                  {product.zh_category}
                </Badge>
              )}
              <h1 className="font-bold text-3xl/[1.1] text-shadow-lg text-shadow-black/50 lg:text-5xl">
                {parseCourseName(product)}
              </h1>
              {subtitle && (
                <p className="text-base/[1.25] text-white-700 text-shadow-lg text-shadow-black/50 lg:text-lg/[1.25]">
                  {subtitle}
                </p>
              )}
            </div>
              <BuyCourseButton
                courseId={courseId}
                courseName={product.zh_name}
                courseCategory={product.zh_category}
                coursePrice={product.group_price || product.single_price}
                className="relative z-1 w-auto text-base shadow-md shadow-black/50 lg:text-lg"
              >
                立即報名
              </BuyCourseButton>
      </Cover>
      {courseId === 6 && <CourseProgressTracker courseId={courseId} />}
      <div className="mt-8 space-y-8">
        <Bar product={product} />
        {courseId === 6 && <RoleSelector />}
        <CourseInfo
          courseId={courseId}
          groupPrice={product.group_price}
          groupPriceEarly={product.group_price_early}
          singlePrice={product.single_price}
          singlePriceEarly={product.single_price_early}
        />
        <Content product={product} courseId={courseId} />
        {courseId === 6 && <PreparationChecklist courseId={courseId} />}
        {courseId !== 6 && <HighlightGrid items={items} courseId={courseId} />}
        <FAQ items={faqItems} />
        {courseId === 6 && <ScrollBottomDetector />}
        {courseId === 6 && <ExplorerReward courseId={courseId} />}
        <BuyCourseButton
          courseId={courseId}
          courseName={product.zh_name}
          courseCategory={product.zh_category}
          coursePrice={product.group_price || product.single_price}
          id="registration"
        >
          立即報名
        </BuyCourseButton>
      </div>
    </Page>
  );
}

function FIXED_SIX(product: any): Item[] {
  return Array.from({ length: 6 }).map((_, i) => {
    const n = i + 1;
    const t = product[`content_highlight${n}`] as string | undefined;
    const d = product[`content_highlight${n}_description`] as
      | string
      | undefined;
    const img =
      (product[`content_highlight${n}_image`] as string | undefined) ||
      product.image;
    return {
      title: t || `Highlight ${n}`,
      description: d || "Details coming soon.",
      image: img,
    };
  });
}
