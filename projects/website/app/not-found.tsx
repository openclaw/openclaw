'use client';

import { Button } from '@/components/ui/button';
import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="max-w-md w-full space-y-8 text-center">
        <div className="space-y-4">
          <div className="text-6xl">🔍</div>
          <h1 className="font-heading text-3xl font-bold">找不到頁面</h1>
          <p className="text-muted-foreground">
            抱歉，你訪問的頁面不存在。
          </p>
          <p className="text-lg font-mono text-muted-foreground">404</p>
        </div>

        <div className="flex flex-col sm:flex-row gap-4 justify-center">
          <Button
            asChild
            className="bg-gradient-to-r from-orange-500 to-pink-500 hover:from-orange-600 hover:to-pink-600"
          >
            <Link href="/">返回首頁</Link>
          </Button>
          <Button variant="outline" asChild>
            <Link href="/products">瀏覽課程</Link>
          </Button>
        </div>

        <div className="pt-8 text-sm text-muted-foreground">
          <p>需要幫助嗎？</p>
          <a
            href="mailto:contact@thinkcafe.tw"
            className="text-primary hover:underline"
          >
            聯絡我們
          </a>
        </div>
      </div>
    </div>
  );
}
