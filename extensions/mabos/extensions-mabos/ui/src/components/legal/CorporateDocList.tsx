import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/ui/status-badge";
import type { CorporateDocument } from "@/lib/types";

type Props = {
  documents: CorporateDocument[];
  isLoading?: boolean;
};

const docTypeLabels: Record<string, string> = {
  articles_of_incorporation: "Articles of Incorporation",
  stock_certificate: "Stock Certificate",
  operating_agreement: "Operating Agreement",
  bylaws: "Bylaws",
  ein_letter: "EIN Letter",
  business_license: "Business License",
};

export function CorporateDocList({ documents, isLoading }: Props) {
  if (isLoading) {
    return (
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <Card key={i} className="border-[var(--border-mabos)] shadow-none">
            <CardContent className="py-4 space-y-2">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-3 w-48" />
              <Skeleton className="h-3 w-24" />
            </CardContent>
          </Card>
        ))}
      </div>
    );
  }

  if (documents.length === 0) {
    return (
      <div className="text-center py-6 text-sm text-[var(--text-muted)]">
        No corporate documents found
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {documents.map((doc) => (
        <Card
          key={doc.id}
          className="border-[var(--border-mabos)] bg-[var(--bg-card)] shadow-none hover:border-[var(--border-hover)] transition-colors"
        >
          <CardContent className="py-4 space-y-2">
            <div className="flex items-center justify-between">
              <StatusBadge status={doc.doc_type} />
              <StatusBadge status={doc.status} />
            </div>
            <p className="text-sm font-medium text-[var(--text-primary)]">
              {doc.title || docTypeLabels[doc.doc_type] || doc.doc_type}
            </p>
            <div className="flex items-center justify-between text-xs text-[var(--text-muted)]">
              <span>{doc.jurisdiction || "—"}</span>
              <span>{doc.filing_date ? new Date(doc.filing_date).toLocaleDateString() : "—"}</span>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
