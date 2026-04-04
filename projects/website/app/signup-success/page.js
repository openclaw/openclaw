'use client';
import { useRouter } from 'next/navigation';
import Page from '@/components/core/Page.js';
import Cover from '@/components/core/Cover.js';
import Title from '@/components/core/Title.js';
import FormFooter from '@/components/core/FormFooter.js';
import FormButton from '@/components/core/FormButton.js';

export default function SignupSuccessPage() {
  const router = useRouter();

  return (
    <Page>
      <Cover>
        <Title>註冊成功</Title>
      </Cover>
      <p className="text-center">
        感謝您註冊成為 Thinker Cafe 的學員，接下來請盡情探索我們為您準備的精彩課程吧！
      </p>
      <FormFooter>
        <FormButton
          primary
          type="button"
          onClick={() => router.push('/products')}
        >
          探索課程
        </FormButton>
      </FormFooter>
    </Page>
  );
}
