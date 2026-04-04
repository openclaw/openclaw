import NoAuthPageWrapper from '@/components/core/NoAuthPageWrapper.js';
import SignUpPage from './SignUpPage.js';
import parseMetadataTitle from '@/utils/parseMetadataTitle.js';

export const metadata = {
  title: parseMetadataTitle('學員註冊'),
};

export default function NoAuthSignUpPage() {
  return (
    <NoAuthPageWrapper>
      <SignUpPage />
    </NoAuthPageWrapper>
  );
}
