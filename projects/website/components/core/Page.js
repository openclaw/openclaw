import { cn } from '@/lib/utils';

export default function Page({ fullScreenWidth, className, children }) {
  return (
    <div className={cn(!fullScreenWidth && 'max-w-6xl px-5 mx-auto', className)}>
      {children}
    </div>
  );
}
