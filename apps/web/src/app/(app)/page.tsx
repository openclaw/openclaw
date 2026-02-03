import { redirect } from 'next/navigation'

export default function HomePage() {
  // Redirect to admin panel
  redirect('/admin')
}
