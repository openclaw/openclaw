'use client';
import { usePathname } from 'next/navigation';
import Link from 'next/link';

export default function Footer() {
  const pathname = usePathname();
  const startYear = 2025;
  const currentYear = new Date().getFullYear();
  const copyrightYear = currentYear > startYear ? `${startYear}–${currentYear}` : `${startYear}`;
  const moreInfoUrlPrefix = pathname === '/more-info' ? '' : '/more-info';

  return (
    <div className="flex flex-col items-center w-full max-w-6xl px-5 pt-18 pb-5 mx-auto text-sm">
      <p className="text-foreground">
        &copy; {copyrightYear} 思考者咖啡有限公司 版權所有
      </p>
      <p className="flex flex-wrap justify-center gap-x-3">
        <Link
          href={`${moreInfoUrlPrefix}#company`}
          className="text-gray-400 hover:text-foreground"
        >
          公司資訊
        </Link>
        <Link
          href={`${moreInfoUrlPrefix}#privacy`}
          className="text-gray-400 hover:text-foreground"
        >
          隱私權政策
        </Link>
        <Link
          href={`${moreInfoUrlPrefix}#tos`}
          className="text-gray-400 hover:text-foreground"
        >
          學生權益
        </Link>
        <Link
          href={`${moreInfoUrlPrefix}#refund`}
          className="text-gray-400 hover:text-foreground"
        >
          退費政策
        </Link>
        <Link
          href={`${moreInfoUrlPrefix}#contact`}
          className="text-gray-400 hover:text-foreground"
        >
          聯絡客服
        </Link>
      </p>
    </div>
  );
}
