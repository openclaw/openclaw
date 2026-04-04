import { redirect, notFound } from 'next/navigation';
import { createClient } from '@/utils/supabase/server';
import { getProducts } from '@/lib/notion';
import Page from '@/components/core/Page.js';
import Cover from '@/components/core/Cover.js';
import Title from '@/components/core/Title.js';
import CreatedOrderForm from './CreatedOrderForm.js';
import PayedOrMessagedOrderForm from './PayedOrMessagedOrderForm.js';
import ConfirmedOrderForm from './ConfirmedOrderForm.js';
import parseMetadataTitle from '@/utils/parseMetadataTitle.js';

export const metadata = {
  title: parseMetadataTitle('報名課程'),
};

export default async function OrderPage({ params }) {
  const { order_id } = await params;
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    const currentPath = `/order/${order_id}`;
    redirect(`/signin?redirect=${encodeURIComponent(currentPath)}`);
  }

  const { data: orderData, error: orderError } = await supabase
    .from('orders')
    .select()
    .eq('order_id', order_id);
  if (orderError || orderData.length === 0) {
    notFound();
  }

  const { data: profileData, error: profileError } = await supabase
    .from('profiles')
    .select()
    .eq('user_id', user.id);
  if (profileError || profileData.length === 0) {
    notFound();
  }

  const order = orderData[0];
  const profile = profileData[0];
  const courses = await getProducts();
  const course = courses.find(({ course_id }) => course_id === order.course_id);
  if (!course) {
    notFound();
  }

  return (
    <Page>
      <Cover>
        <Title>報名課程</Title>
      </Cover>
      {order.state === 'created' && (
        <CreatedOrderForm
          order={order}
          profile={profile}
          course={course}
        />
      )}
      {(order.state === 'payed' || order.state === 'messaged') && (
        <PayedOrMessagedOrderForm
          order={order}
          profile={profile}
        />
      )}
      {order.state === 'confirmed' && (
        <ConfirmedOrderForm
          order={order}
          profile={profile}
          course={course}
        />
      )}
    </Page>
  );
}
