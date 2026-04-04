'use client';

import { useEffect } from 'react';
import { Button } from '@/components/ui/button';
import Link from 'next/link';

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Log the error to an error reporting service
    console.error('Error boundary caught:', error);
  }, [error]);

  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="max-w-md w-full space-y-8 text-center">
        <div className="space-y-4">
          <div className="text-6xl">😵</div>
          <h1 className="font-heading text-3xl font-bold">糟糕！出錯了</h1>
          <p className="text-muted-foreground">
            我們遇到了一個預期之外的錯誤。別擔心，這不是你的問題。
          </p>
          {error.digest && (
            <p className="text-xs text-muted-foreground font-mono">
              錯誤 ID: {error.digest}
            </p>
          )}
        </div>

        <div className="flex flex-col sm:flex-row gap-4 justify-center">
          <Button
            onClick={reset}
            className="bg-gradient-to-r from-orange-500 to-pink-500 hover:from-orange-600 hover:to-pink-600"
          >
            重試一次
          </Button>
          <Button variant="outline" asChild>
            <Link href="/">返回首頁</Link>
          </Button>
        </div>

        <div className="pt-8 text-sm text-muted-foreground">
          <p>如果問題持續發生，請聯絡我們：</p>
          <a
            href="mailto:contact@thinkcafe.tw"
            className="text-primary hover:underline"
          >
            contact@thinkcafe.tw
          </a>
        </div>
      </div>
    </div>
  );
}
