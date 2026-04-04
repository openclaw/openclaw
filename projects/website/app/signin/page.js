import NoAuthPageWrapper from '@/components/core/NoAuthPageWrapper.js';
import SignInPage from './SignInPage.js';
import parseMetadataTitle from '@/utils/parseMetadataTitle.js';

export const metadata = {
  title: parseMetadataTitle('學員登入'),
};

export default function NoAuthSignInPage() {
  return (
    <NoAuthPageWrapper>
      <SignInPage />
    </NoAuthPageWrapper>
  );
}
