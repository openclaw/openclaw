import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";

type MarkdownViewerProps = {
  content: string;
  className?: string;
};

export function MarkdownViewer({ content, className }: MarkdownViewerProps) {
  return (
    <div
      className={cn(
        "prose prose-sm max-w-none text-[var(--text-secondary)]",
        // Headings
        "[&_h1]:text-lg [&_h1]:font-bold [&_h1]:text-[var(--text-primary)] [&_h1]:mt-4 [&_h1]:mb-2",
        "[&_h2]:text-base [&_h2]:font-semibold [&_h2]:text-[var(--text-primary)] [&_h2]:mt-3 [&_h2]:mb-2",
        "[&_h3]:text-sm [&_h3]:font-semibold [&_h3]:text-[var(--text-primary)] [&_h3]:mt-3 [&_h3]:mb-1",
        // Paragraphs
        "[&_p]:text-sm [&_p]:leading-relaxed [&_p]:mb-2",
        // Lists
        "[&_ul]:list-disc [&_ul]:pl-5 [&_ul]:mb-2 [&_ul]:text-sm",
        "[&_ol]:list-decimal [&_ol]:pl-5 [&_ol]:mb-2 [&_ol]:text-sm",
        "[&_li]:mb-0.5",
        // Code
        "[&_code]:text-xs [&_code]:font-mono [&_code]:bg-[var(--bg-tertiary)] [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:rounded",
        "[&_pre]:bg-[var(--bg-tertiary)] [&_pre]:p-3 [&_pre]:rounded-lg [&_pre]:overflow-x-auto [&_pre]:mb-3 [&_pre]:text-xs",
        "[&_pre_code]:bg-transparent [&_pre_code]:p-0",
        // Tables
        "[&_table]:w-full [&_table]:text-sm [&_table]:border-collapse [&_table]:mb-3",
        "[&_th]:text-left [&_th]:text-[var(--text-primary)] [&_th]:font-medium [&_th]:px-3 [&_th]:py-1.5 [&_th]:border-b [&_th]:border-[var(--border-mabos)]",
        "[&_td]:px-3 [&_td]:py-1.5 [&_td]:border-b [&_td]:border-[var(--border-mabos)]",
        // Blockquotes
        "[&_blockquote]:border-l-2 [&_blockquote]:border-[var(--accent-purple)] [&_blockquote]:pl-3 [&_blockquote]:italic [&_blockquote]:text-[var(--text-muted)] [&_blockquote]:my-2",
        // Links
        "[&_a]:text-[var(--accent-blue)] [&_a]:underline",
        // Horizontal rules
        "[&_hr]:border-[var(--border-mabos)] [&_hr]:my-4",
        // Task lists (GFM)
        "[&_input[type=checkbox]]:mr-2",
        // Strong / em
        "[&_strong]:text-[var(--text-primary)] [&_strong]:font-semibold",
        className,
      )}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    </div>
  );
}
