"use client";

import { Suspense } from "react";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { pageTransition } from "@/lib/motion";
import { PageHeader } from "@/components/ui/page-header";
import { TabBar, useTab } from "@/components/tab-bar";
import { GlassCard } from "@/components/ui/glass-card";
import { EmptyState } from "@/components/ui/empty-state";
import { SkeletonCard } from "@/components/ui/skeleton-card";
import { Package, ArrowLeft } from "lucide-react";
import Link from "next/link";

const detailTabs = [
  { id: "overview", label: "Overview" },
  { id: "brand", label: "Brand" },
  { id: "community", label: "Community" },
  { id: "content", label: "Content" },
  { id: "product", label: "Product" },
  { id: "actions", label: "Actions" },
];

interface EcoDetail {
  slug: string;
  overview: string;
  metrics: Record<string, number>;
  sections: Record<string, string>;
  files: string[];
}

function EcosystemDetailContent() {
  const { slug } = useParams<{ slug: string }>();
  const activeTab = useTab(detailTabs, "overview");
  const [data, setData] = useState<EcoDetail | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/ecosystem/${slug}`)
      .then((r) => r.json())
      .then((json) => {
        setData(json.data || null);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [slug]);

  if (loading) {
    return <SkeletonCard lines={5} />;
  }

  return (
    <>
      <div className="mb-4">
        <Link
          href="/knowledge?tab=ecosystem"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors mb-2"
        >
          <ArrowLeft className="w-3 h-3" /> Back to Ecosystem
        </Link>
      </div>
      <PageHeader
        title={slug.charAt(0).toUpperCase() + slug.slice(1)}
        description="Ecosystem product detail"
      />
      <div className="mb-4">
        <TabBar tabs={detailTabs} defaultTab="overview" layoutId="eco-detail-tabs" />
      </div>

      {!data ? (
        <GlassCard>
          <EmptyState
            icon={Package}
            title="Product not found"
            description={`No data found for "${slug}". Create files at workspace/ecosystem/${slug}/ to populate.`}
          />
        </GlassCard>
      ) : (
        <GlassCard>
          {activeTab === "overview" && (
            <div>
              {data.overview ? (
                <pre className="text-xs text-foreground/80 whitespace-pre-wrap font-sans leading-relaxed">
                  {data.overview}
                </pre>
              ) : (
                <p className="text-xs text-muted-foreground">No overview available.</p>
              )}
              {Object.keys(data.metrics).length > 0 && (
                <div className="mt-4 pt-4 border-t border-white/[0.06]">
                  <h4 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">Metrics</h4>
                  <div className="grid grid-cols-3 gap-3">
                    {Object.entries(data.metrics).map(([key, val]) => (
                      <div key={key} className="p-2 rounded-lg bg-white/[0.02]">
                        <p className="text-lg font-semibold">{val}</p>
                        <p className="text-[10px] text-muted-foreground capitalize">{key}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
          {activeTab !== "overview" && (
            <div>
              {data.sections[activeTab] ? (
                <pre className="text-xs text-foreground/80 whitespace-pre-wrap font-sans leading-relaxed">
                  {data.sections[activeTab]}
                </pre>
              ) : (
                <p className="text-xs text-muted-foreground">
                  No {activeTab} data. Create {activeTab}.md in the product directory.
                </p>
              )}
            </div>
          )}
        </GlassCard>
      )}
    </>
  );
}

export default function EcosystemDetailPage() {
  return (
    <motion.div
      variants={pageTransition}
      initial="initial"
      animate="animate"
      exit="exit"
      className="px-3 sm:px-4 lg:px-6 py-4"
    >
      <Suspense fallback={<SkeletonCard lines={5} />}>
        <EcosystemDetailContent />
      </Suspense>
    </motion.div>
  );
}
