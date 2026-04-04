export const runtime = "nodejs";
export const revalidate = 3600;

import { Card, CardContent } from "@/components/ui/card";
import { CountUp } from "@/components/count-number";
import {
  getOurStoryContent,
  getOurValueContent,
  getOurTeamContent,
  getOurMissionVisionContent,
  type NotionOurStory,
  type NotionOurValue,
  type NotionOurTeam,
  type NotionOurMissionVision,
} from "@/lib/notion";
import parseMetadataTitle from '@/utils/parseMetadataTitle.js';
import Image from "next/image";

export const metadata = {
  title: parseMetadataTitle('團隊簡介'),
  description: '認識 Thinker Cafe 團隊，了解我們的願景、使命與價值觀。我們致力於讓 AI 教育更普及，幫助每個人在 AI 時代找到自己的定位。',
  alternates: {
    canonical: 'https://www.thinker.cafe/about',
  },
  openGraph: {
    title: '團隊簡介 | Thinker Cafe',
    description: '認識 Thinker Cafe 團隊，了解我們的願景、使命與價值觀',
    url: 'https://www.thinker.cafe/about',
    siteName: 'Thinker Cafe',
    locale: 'zh_TW',
    type: 'website',
  },
};

export default async function AboutPage() {
  const [values, team, storyList, missionVision] = await Promise.all([
    getOurValueContent(),
    getOurTeamContent(),
    getOurStoryContent(),
    getOurMissionVisionContent(),
  ]);

  // AboutPage Schema for SEO
  const aboutPageSchema = {
    "@context": "https://schema.org",
    "@type": "AboutPage",
    "name": "關於 Thinker Cafe",
    "description": "認識 Thinker Cafe 團隊，了解我們的願景、使命與價值觀",
    "mainEntity": {
      "@type": "Organization",
      "name": "Thinker Cafe",
      "alternateName": "思考者咖啡",
      "url": "https://www.thinker.cafe",
      "description": "AI 時代的實戰課程平台",
      "foundingDate": "2024",
    }
  };

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(aboutPageSchema) }}
      />
      <section className="relative overflow-hidden py-20 lg:py-32">
        <div className="container mx-auto px-4">
          <div className="mx-auto max-w-4xl text-center">
            <h1
              className="font-heading text-4xl font-bold tracking-tight lg:text-6xl"
            >
              當<span className="text-primary">科技</span>回歸人性，智慧便有了溫度
            </h1>
            <p className="mt-6 text-lg text-muted-foreground lg:text-xl">
              我們堅信，AI 不該是少數人的專利。透過創新與信任，我們致力於建立屬於這個時代的新平衡，讓每個人都能自由學習、持續成長。
            </p>
          </div>
        </div>
      </section>
      {storyList.map(({ id, zh_title, zh_description, image }) => (
        <section key={id} className="py-20">
          <div className="container mx-auto px-4">
            <div className="grid gap-12 lg:grid-cols-12 items-start">
              <div className="lg:col-span-7">
                <h2 className="font-heading text-3xl font-bold lg:text-4xl mb-6 text-center lg:text-left">
                  {zh_title}
                </h2>
                <div className="space-y-4 text-muted-foreground max-w-[720px] whitespace-pre-line">
                  {zh_description}
                </div>
              </div>
              <div className="lg:col-span-5">
                <div className="relative w-full max-w-[520px] mx-auto rounded-xl shadow-2xl aspect-[4/3]">
                  <Image
                    src={image}
                    alt={zh_title}
                    fill
                    sizes="(max-width: 1024px) 100vw, 520px"
                    className="object-cover rounded-xl"
                    loading="lazy"
                  />
                </div>
              </div>
            </div>
          </div>
        </section>
      ))}
      <section className="py-20 bg-muted/30">
        <div className="container mx-auto px-4">
          <div className="mx-auto max-w-2xl text-center mb-16">
            <h2 className="font-heading text-3xl font-bold lg:text-4xl">
              我們的價值觀
            </h2>
            <p className="mt-4 text-muted-foreground">
              這些原則引領著思考者咖啡不斷前進，塑造我們的文化和決策。
            </p>
          </div>
          <div className="grid gap-8 md:grid-cols-2 lg:grid-cols-3">
            {(values?.length ? values : []).map(
              (v: NotionOurValue ) => {
                return (
                  <Card
                    key={v.id}
                    className="border-0 bg-card/50 backdrop-blur"
                  >
                    <CardContent className="p-6 text-center">
                      <div
                        className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-accent/10 hover:bg-primary/10"
                      >
                        <Image
                          src={v.image}
                          alt={v.zh_title }
                          width={40}
                          height={40}
                          className="text-accent hover:text-primary"
                          loading="lazy"
                        />
                      </div>
                      <h3 className="font-heading text-xl font-semibold mb-3">
                        {v.zh_title}
                      </h3>
                      <p className="text-sm text-muted-foreground">{v.zh_description}</p>
                    </CardContent>
                  </Card>
                );
              }
            )}
          </div>
        </div>
      </section>
      <section className="py-20">
        <div className="container mx-auto px-4">
          <div className="grid gap-12 lg:grid-cols-2 lg:gap-20">
             {(missionVision?.length ? missionVision : []).map(
              (mv: NotionOurMissionVision ) => {
                return (
                  <Card
                    key={mv.id}
                    className="border-0 bg-gradient-to-br from-primary/5 to-primary/10 p-8"
                  >
                    <CardContent className="p-0">
                      <div
                        className="mb-6"
                      >
                         <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-primary/20 mb-4">
                           <Image
                             src={mv.image}
                             alt={mv.zh_title}
                             width={48}
                             height={48}
                             className="text-accent hover:text-primary"
                             loading="lazy"
                           />
                         </div>
                      </div>
                      <h3 className="font-heading text-2xl font-bold">
                        {mv.zh_title}
                      </h3>
                      <p className="text-muted-foreground">{mv.zh_description}</p>
                    </CardContent>
                  </Card>
                );
              }
            )}
          </div>
        </div>
      </section>
      {/*
      <section className="py-20 bg-muted/30">
        <div className="container mx-auto px-4">
          <div className="mx-auto max-w-2xl text-center mb-16">
            <h2 className="font-heading text-3xl font-bold lg:text-4xl">
              使用數據
            </h2>
            <p className="mt-4 text-muted-foreground">
              我們的旅程以數字為依據。
            </p>
          </div>

          <div className="grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
            <div className="text-center">
              <div className="font-heading text-4xl font-bold text-primary mb-2">
                <CountUp end={50} suffix="K+" />
              </div>
              <div className="text-sm text-muted-foreground">課程參與者</div>
            </div>
            <div className="text-center">
              <div className="font-heading text-4xl font-bold text-accent mb-2">
                <CountUp end={1200} suffix="+" />
              </div>
              <div className="text-sm text-muted-foreground">產品合作夥伴</div>
            </div>
            <div className="text-center">
              <div className="font-heading text-4xl font-bold text-primary mb-2">
                <CountUp end={25} suffix="+" />
              </div>
              <div className="text-sm text-muted-foreground">產品課程</div>
            </div>
            <div className="text-center">
              <div className="font-heading text-4xl font-bold text-accent mb-2">
                <CountUp end={99} suffix="%" />
              </div>
              <div className="text-sm text-muted-foreground">客戶滿意度</div>
            </div>
          </div>
        </div>
      </section>
      */}
      <section className="py-20">
        <div className="container mx-auto px-4">
          <div className="mx-auto max-w-2xl text-center mb-16">
            <h2 className="font-heading text-3xl font-bold lg:text-4xl">
              認識我們
            </h2>
            <p className="mt-4 text-muted-foreground">
              這些人們是思考者咖啡成功的背後推手。
            </p>
          </div>
          <div className="grid gap-8 sm:grid-cols-2 lg:grid-cols-3">
            {(team?.length ? team : []).map((m: NotionOurTeam) => (
              <Card
                key={m.id}
                className="border-0 bg-card/50 backdrop-blur text-center"
              >
                <CardContent className="p-6">
                  <div className="relative mx-auto h-20 w-20 mb-4">
                    <Image
                      src={m.image || "/coffee-shop-founder-headshot.png"}
                      alt={m.zh_name || "Team member"}
                      fill
                      sizes="80px"
                      className="rounded-full object-cover"
                      loading="lazy"
                    />
                  </div>
                  <h3 className="font-heading text-lg font-semibold">
                    {m.zh_name}
                  </h3>
                  <p className="text-sm text-primary mb-2">
                    {m.zh_role}
                  </p>
                    <p className="text-xs text-muted-foreground">
                      {m.zh_role_description}
                    </p>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      </section>
    </>
  );
}
