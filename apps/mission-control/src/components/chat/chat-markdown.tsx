"use client";

import { memo, useState, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { Check, Copy } from "lucide-react";

function CodeBlock({
  className,
  children,
}: {
  className?: string;
  children?: React.ReactNode;
}) {
  const [copied, setCopied] = useState(false);
  const language = className?.replace("hljs language-", "")?.replace("language-", "") ?? "";
  const code = String(children).replace(/\n$/, "");

  const handleCopy = useCallback(() => {
    void navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [code]);

  return (
    <div className="chat-code-block group relative my-3 rounded-lg overflow-hidden border border-border/60 bg-[#0d1117]">
      <div className="flex items-center justify-between px-3 py-1.5 bg-[#161b22] border-b border-border/40 text-[11px]">
        <span className="text-muted-foreground font-mono">{language || "text"}</span>
        <button
          onClick={handleCopy}
          className="flex items-center gap-1 text-muted-foreground hover:text-foreground transition-colors"
          aria-label="Copy code"
        >
          {copied ? (
            <>
              <Check className="w-3 h-3 text-emerald-400" />
              <span className="text-emerald-400">Copied</span>
            </>
          ) : (
            <>
              <Copy className="w-3 h-3" />
              <span>Copy</span>
            </>
          )}
        </button>
      </div>
      <pre className="overflow-x-auto p-3 text-[13px] leading-relaxed">
        <code className={className}>{children}</code>
      </pre>
    </div>
  );
}

function InlineCode({ children }: { children?: React.ReactNode }) {
  return (
    <code className="bg-muted/60 border border-border/40 rounded px-1.5 py-0.5 text-[13px] font-mono text-primary/90">
      {children}
    </code>
  );
}

const REMARK_PLUGINS = [remarkGfm];
const REHYPE_PLUGINS = [rehypeHighlight];

const markdownComponents = {
  // Code blocks (fenced) vs inline code
  code(props: React.ComponentPropsWithoutRef<"code">) {
    const { className, children } = props;
    const isBlock = className?.includes("language-") || className?.includes("hljs");
    if (isBlock) {
      return <CodeBlock className={className}>{children}</CodeBlock>;
    }
    return <InlineCode>{children}</InlineCode>;
  },

  // Pre element — for code blocks without language identifier
  pre({ children }: { children?: React.ReactNode }) {
    return <>{children}</>;
  },

  // Links open in new tab
  a({ href, children }: { href?: string; children?: React.ReactNode }) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="text-primary hover:underline"
      >
        {children}
      </a>
    );
  },

  // Tables
  table({ children }: { children?: React.ReactNode }) {
    return (
      <div className="overflow-x-auto my-3">
        <table className="min-w-full text-sm border-collapse border border-border/50 rounded-lg overflow-hidden">
          {children}
        </table>
      </div>
    );
  },
  th({ children }: { children?: React.ReactNode }) {
    return (
      <th className="border border-border/40 bg-muted/40 px-3 py-1.5 text-left text-xs font-semibold uppercase tracking-wider">
        {children}
      </th>
    );
  },
  td({ children }: { children?: React.ReactNode }) {
    return <td className="border border-border/40 px-3 py-1.5">{children}</td>;
  },

  // Block elements
  p({ children }: { children?: React.ReactNode }) {
    return <p className="mb-2 last:mb-0 leading-relaxed">{children}</p>;
  },
  ul({ children }: { children?: React.ReactNode }) {
    return <ul className="mb-2 pl-5 list-disc space-y-0.5">{children}</ul>;
  },
  ol({ children }: { children?: React.ReactNode }) {
    return <ol className="mb-2 pl-5 list-decimal space-y-0.5">{children}</ol>;
  },
  li({ children }: { children?: React.ReactNode }) {
    return <li className="leading-relaxed">{children}</li>;
  },
  blockquote({ children }: { children?: React.ReactNode }) {
    return (
      <blockquote className="border-l-3 border-primary/40 pl-3 my-2 text-muted-foreground italic">
        {children}
      </blockquote>
    );
  },
  h1({ children }: { children?: React.ReactNode }) {
    return <h1 className="text-lg font-bold mt-4 mb-2">{children}</h1>;
  },
  h2({ children }: { children?: React.ReactNode }) {
    return <h2 className="text-base font-bold mt-3 mb-2">{children}</h2>;
  },
  h3({ children }: { children?: React.ReactNode }) {
    return <h3 className="text-sm font-bold mt-3 mb-1">{children}</h3>;
  },
  hr() {
    return <hr className="my-3 border-border/50" />;
  },
};

function ChatMarkdownInner({ content }: { content: string }) {
  return (
    <div className="chat-markdown text-sm leading-relaxed break-words">
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={REHYPE_PLUGINS}
        components={markdownComponents}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

export const ChatMarkdown = memo(ChatMarkdownInner, (prev, next) => prev.content === next.content);
