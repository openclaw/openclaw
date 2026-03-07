/*
 * © 2026 Full Digital LLC. All Rights Reserved.
 * CUTMV - Back to Tool Button
 * Persistent navigation element for returning to main tool
 */

import { Link } from 'wouter';
import { Button } from '@/components/ui/button';
import { Video, ChevronLeft } from 'lucide-react';

interface BackToToolButtonProps {
  className?: string;
  variant?: 'default' | 'outline' | 'ghost';
  size?: 'default' | 'sm' | 'lg';
}

export default function BackToToolButton({ 
  className = '', 
  variant = 'default',
  size = 'default'
}: BackToToolButtonProps) {
  return (
    <Link href="/app">
      <Button 
        variant={variant}
        size={size}
        className={`bg-brand-green hover:bg-brand-green-light text-brand-black font-semibold ${className}`}
      >
        <Video className="w-4 h-4 mr-2" />
        Back to Tool
      </Button>
    </Link>
  );
}

export function BackToToolBreadcrumb({ className = '' }: { className?: string }) {
  return (
    <div className={`flex items-center text-sm text-gray-600 ${className}`}>
      <Link href="/app" className="flex items-center hover:text-brand-green transition-colors">
        <ChevronLeft className="w-4 h-4" />
        Back to Tool
      </Link>
    </div>
  );
}