import { EditionsPage } from '@/components/EditionsPage';
import { SmoothScrollProvider } from '@/components/SmoothScrollProvider';

export default function Page() {
  return (
    <SmoothScrollProvider>
      <EditionsPage />
    </SmoothScrollProvider>
  );
}
