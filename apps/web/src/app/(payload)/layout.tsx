import type { ReactNode } from 'react'
import { RootLayout } from '@payloadcms/next/layouts'
import config from '@/payload.config'
import '@payloadcms/next/css'

type Props = {
  children: ReactNode
}

const Layout = ({ children }: Props) => <RootLayout config={config}>{children}</RootLayout>

export default Layout
