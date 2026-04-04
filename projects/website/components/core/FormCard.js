import { cn } from '@/lib/utils';

export default function FormCard({ id, title, error, compact, singleColumn, className, children }) {
  return (
    <div className={cn('p-5 rounded-xl text-card-foreground shadow-sm', !error && 'bg-card/50', error && 'bg-red-900/75', className)} id={id}>
      {title && (
        <h2 className={cn(compact ? 'mb-4' : 'mb-7', 'text-xl font-semibold lg:text-2xl')}>
          {title}
        </h2>
      )}
      <div className={cn('grid grid-cols-1 gap-5 items-start', !singleColumn && 'md:grid-cols-2')}>
        {children}
      </div>
    </div>
  );
}
