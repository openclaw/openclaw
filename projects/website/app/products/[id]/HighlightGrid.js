import RevealItem from '@/components/cards-reveal-grid.tsx';
import HighlightCard from './HighlightCard.js';

export default function HighlightGrid({ items, courseId }) {
  const positionClasses = [
    'lg:col-start-1 lg:row-start-1 lg:col-span-3 lg:row-span-3',
    'lg:col-start-4 lg:row-start-1 lg:col-span-3 lg:row-span-2',
    'lg:col-start-4 lg:row-start-3 lg:col-span-2 lg:row-span-1',
    'lg:col-start-6 lg:row-start-3 lg:col-span-1 lg:row-span-1',
    'lg:col-start-1 lg:row-start-4 lg:col-span-4 lg:row-span-2',
    'lg:col-start-5 lg:row-start-4 lg:col-span-2 lg:row-span-2',
  ];

  return (
    <div className="grid grid-cols-1 gap-5 md:grid-cols-2 lg:grid-cols-6 lg:auto-rows-[180px]">
      {items.map((item, index) => (
        <RevealItem key={item.title} index={index} className={positionClasses[index]}>
          <HighlightCard item={item} index={index} courseId={courseId} />
        </RevealItem>
      ))}
    </div>
  );
}
