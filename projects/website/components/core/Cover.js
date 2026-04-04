import { cn } from '@/lib/utils';

export default function Cover({ fullScreenHeight, className, children }) {
  return (
    <div className={cn(!fullScreenHeight && 'flex flex-col justify-center items-center gap-y-5 pt-37 pb-18', fullScreenHeight && 'h-screen', className)}>
      {children}
    </div>
  );
}
